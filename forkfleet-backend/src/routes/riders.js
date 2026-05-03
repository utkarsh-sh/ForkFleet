const router = require('express').Router();
const { body } = require('express-validator');
const db = require('../db');
const { redis, publishOrderEvent } = require('../db/redis');
const { ok, created, badRequest, notFound, serverError } = require('../utils/response');
const { authenticate, authorize } = require('../middleware/auth');
const { validate } = require('../middleware/errorHandler');
const logger = require('../utils/logger');

router.use(authenticate);

router.get('/me', authorize('rider', 'admin'), async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT r.*, u.name, u.phone, u.email
       FROM riders r JOIN users u ON u.id = r.user_id
       WHERE r.user_id = $1`,
      [req.user.id]
    );
    if (!rows.length) return notFound(res, 'Rider profile not found');
    return ok(res, { rider: rows[0] });
  } catch {
    return serverError(res);
  }
});

router.patch(
  '/me/status',
  authorize('rider'),
  [body('status').isIn(['offline', 'available', 'on_delivery'])],
  validate,
  async (req, res) => {
    try {
      await db.query(`UPDATE riders SET status = $1, last_seen_at = NOW() WHERE user_id = $2`, [
        req.body.status,
        req.user.id,
      ]);

      if (req.body.status === 'available') await redis.sadd('riders:available', req.user.id);
      else await redis.srem('riders:available', req.user.id);

      return ok(res, { status: req.body.status });
    } catch {
      return serverError(res);
    }
  }
);

router.patch(
  '/location',
  authorize('rider'),
  [
    body('latitude').isFloat({ min: -90, max: 90 }),
    body('longitude').isFloat({ min: -180, max: 180 }),
    body('accuracy').optional().isFloat({ min: 0 }),
  ],
  validate,
  async (req, res) => {
    try {
      const { latitude, longitude, accuracy } = req.body;
      await db.query(`UPDATE riders SET latitude = $1, longitude = $2, last_seen_at = NOW() WHERE user_id = $3`, [
        latitude,
        longitude,
        req.user.id,
      ]);

      await redis.geoadd('riders:geo', longitude, latitude, req.user.id);

      const activeJob = await redis.get(`rider:active_job:${req.user.id}`);
      if (activeJob) {
        const job = JSON.parse(activeJob);
        await publishOrderEvent(job.order_id, {
          event: 'rider_location_updated',
          riderId: req.user.id,
          latitude,
          longitude,
          accuracy,
        });
      }

      return ok(res, { received: true });
    } catch {
      return serverError(res);
    }
  }
);

router.get('/jobs/available', authorize('rider', 'admin'), async (_req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT dj.id, dj.order_id, dj.pickup_sequence, dj.dropoff_address,
              o.grand_total, o.restaurant_count
       FROM delivery_jobs dj
       JOIN orders o ON o.id = dj.order_id
       WHERE dj.status = 'pending_assignment' AND o.status = 'confirmed'
       ORDER BY dj.created_at ASC
       LIMIT 5`
    );
    return ok(res, { jobs: rows });
  } catch {
    return serverError(res);
  }
});

router.post('/jobs/:jobId/accept', authorize('rider'), async (req, res) => {
  try {
    const { rows: [rider] } = await db.query('SELECT * FROM riders WHERE user_id = $1', [req.user.id]);
    if (!rider) return notFound(res, 'Rider profile not found');
    if (rider.status !== 'available') return badRequest(res, 'You must be available to accept a job');

    const job = await db.withTransaction(async (trx) => {
      const { rows: [lockedJob] } = await trx.query(
        `SELECT * FROM delivery_jobs WHERE id = $1 AND status = 'pending_assignment' FOR UPDATE`,
        [req.params.jobId]
      );
      if (!lockedJob) throw Object.assign(new Error('Job no longer available'), { statusCode: 409 });

      await trx.query(`UPDATE delivery_jobs SET rider_id = $1, status = 'assigned', assigned_at = NOW() WHERE id = $2`, [
        rider.id,
        req.params.jobId,
      ]);
      await trx.query(`UPDATE riders SET status = 'on_delivery' WHERE id = $1`, [rider.id]);
      await trx.query(`UPDATE orders SET status = 'rider_assigned', updated_at = NOW() WHERE id = $1`, [lockedJob.order_id]);
      return lockedJob;
    });

    await redis.set(`rider:active_job:${req.user.id}`, JSON.stringify({ job_id: req.params.jobId, order_id: job.order_id }), 'EX', 86400);
    await redis.srem('riders:available', req.user.id);

    await publishOrderEvent(job.order_id, {
      event: 'rider_assigned',
      orderId: job.order_id,
      jobId: req.params.jobId,
      riderId: rider.id,
    });

    return ok(res, { job, message: 'Job accepted' });
  } catch (err) {
    if (err.statusCode) return badRequest(res, err.message);
    logger.error('Accept rider job error', { error: err.message });
    return serverError(res);
  }
});

router.post('/jobs/:jobId/decline', authorize('rider'), async (req, res) => {
  logger.info('Rider declined job', { userId: req.user.id, jobId: req.params.jobId });
  return ok(res, { message: 'Job declined' });
});

router.patch(
  '/jobs/:jobId/stop',
  authorize('rider'),
  [
    body('stop_index').isInt({ min: 0 }),
    body('action').isIn(['arrived', 'collected', 'dropped']),
    body('otp').optional().isString().isLength({ min: 4, max: 4 }),
  ],
  validate,
  async (req, res) => {
    try {
      const { rows: [job] } = await db.query(
        `SELECT dj.*, o.id AS order_id
         FROM delivery_jobs dj
         JOIN orders o ON o.id = dj.order_id
         WHERE dj.id = $1`,
        [req.params.jobId]
      );
      if (!job) return notFound(res, 'Job not found');

      const sequence = job.pickup_sequence || [];
      const stop = sequence[req.body.stop_index];
      if (!stop) return badRequest(res, 'Invalid stop index');

      if (req.body.action === 'dropped') {
        const expectedOtp = await redis.get(`otp:order:${job.order_id}`);
        if (expectedOtp && req.body.otp !== expectedOtp) return badRequest(res, 'Incorrect OTP');
      }

      if (req.body.action === 'collected' && stop.sub_order_id) {
        await db.query(`UPDATE sub_orders SET status = 'picked_up', picked_up_at = NOW() WHERE id = $1`, [stop.sub_order_id]);
        await db.query(`UPDATE delivery_jobs SET status = 'collecting', updated_at = NOW() WHERE id = $1`, [req.params.jobId]);
      }

      if (req.body.action === 'dropped') {
        await db.withTransaction(async (trx) => {
          await trx.query(`UPDATE orders SET status = 'delivered', delivered_at = NOW() WHERE id = $1`, [job.order_id]);
          await trx.query(`UPDATE delivery_jobs SET status = 'delivered', delivered_at = NOW() WHERE id = $1`, [req.params.jobId]);
          await trx.query(`UPDATE riders SET status = 'available' WHERE id = (SELECT id FROM riders WHERE user_id = $1)`, [req.user.id]);
        });

        await redis.del(`rider:active_job:${req.user.id}`);
        await redis.sadd('riders:available', req.user.id);
      }

      await publishOrderEvent(job.order_id, {
        event: 'delivery_stop_updated',
        orderId: job.order_id,
        jobId: req.params.jobId,
        stop_index: req.body.stop_index,
        action: req.body.action,
      });

      return ok(res, { jobId: req.params.jobId, stop_index: req.body.stop_index, action: req.body.action });
    } catch (err) {
      logger.error('Stop update error', { error: err.message });
      return serverError(res);
    }
  }
);

router.get('/me/history', authorize('rider'), async (req, res) => {
  const page = Math.max(1, Number(req.query.page || 1));
  const limit = Math.min(50, Math.max(1, Number(req.query.limit || 20)));
  const offset = (page - 1) * limit;

  try {
    const { rows } = await db.query(
      `SELECT dj.id, dj.order_id, dj.status, dj.delivered_at, dj.pickup_sequence,
              o.grand_total, o.restaurant_count,
              (o.restaurant_count * 3000) AS payout_paise
       FROM delivery_jobs dj
       JOIN orders o ON o.id = dj.order_id
       JOIN riders r ON r.id = dj.rider_id
       WHERE r.user_id = $1 AND dj.status = 'delivered'
       ORDER BY dj.delivered_at DESC
       LIMIT $2 OFFSET $3`,
      [req.user.id, limit, offset]
    );
    return ok(res, { deliveries: rows });
  } catch {
    return serverError(res);
  }
});

router.get('/me/earnings', authorize('rider'), async (req, res) => {
  try {
    const { rows: [e] } = await db.query(
      `SELECT
         COUNT(*) FILTER (WHERE dj.delivered_at >= CURRENT_DATE) AS trips_today,
         COUNT(*) FILTER (WHERE dj.delivered_at >= date_trunc('week', NOW())) AS trips_week,
         COUNT(*) FILTER (WHERE dj.delivered_at >= date_trunc('month', NOW())) AS trips_month,
         COALESCE(SUM((o.restaurant_count * 3000)) FILTER (WHERE dj.delivered_at >= CURRENT_DATE), 0) AS earned_today_paise,
         COALESCE(SUM((o.restaurant_count * 3000)) FILTER (WHERE dj.delivered_at >= date_trunc('week', NOW())), 0) AS earned_week_paise,
         COALESCE(SUM((o.restaurant_count * 3000)) FILTER (WHERE dj.delivered_at >= date_trunc('month', NOW())), 0) AS earned_month_paise
       FROM delivery_jobs dj
       JOIN orders o ON o.id = dj.order_id
       JOIN riders r ON r.id = dj.rider_id
       WHERE r.user_id = $1 AND dj.status = 'delivered'`,
      [req.user.id]
    );

    return ok(res, {
      earnings: {
        today: { trips: Number(e.trips_today), amount_paise: Number(e.earned_today_paise) },
        week: { trips: Number(e.trips_week), amount_paise: Number(e.earned_week_paise) },
        month: { trips: Number(e.trips_month), amount_paise: Number(e.earned_month_paise) },
      },
    });
  } catch {
    return serverError(res);
  }
});

router.post(
  '/register',
  authorize('admin'),
  [
    body('user_id').isUUID(),
    body('vehicle_type').isIn(['motorcycle', 'bicycle', 'car', 'scooter']),
    body('license_no').optional().isString(),
  ],
  validate,
  async (req, res) => {
    try {
      await db.query(`UPDATE users SET role = 'rider' WHERE id = $1`, [req.body.user_id]);
      const { rows: [rider] } = await db.query(
        `INSERT INTO riders (user_id, vehicle_type, license_no)
         VALUES ($1, $2, $3)
         ON CONFLICT (user_id)
         DO UPDATE SET vehicle_type = EXCLUDED.vehicle_type
         RETURNING *`,
        [req.body.user_id, req.body.vehicle_type, req.body.license_no || null]
      );
      return created(res, { rider });
    } catch {
      return serverError(res);
    }
  }
);

module.exports = router;
