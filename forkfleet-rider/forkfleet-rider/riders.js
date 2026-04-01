/**
 * ForkFleet — Rider API Routes
 * Handles: status, location, job assignment, delivery confirmation
 *
 * Add to src/server.js:
 *   app.use(`${API}/riders`, require('./routes/riders'));
 */

const router = require('express').Router();
const { body, param } = require('express-validator');
const db = require('../db');
const { redis, publishOrderEvent } = require('../db/redis');
const { ok, created, badRequest, notFound, forbidden, serverError } = require('../utils/response');
const { authenticate, authorize } = require('../middleware/auth');
const { validate } = require('../middleware/errorHandler');
const logger = require('../utils/logger');

// All rider routes require auth
router.use(authenticate);

// ── GET /riders/me — rider profile ────────────────────────────────────────────

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
  } catch (err) {
    return serverError(res);
  }
});

// ── PATCH /riders/me/status — go online / offline ─────────────────────────────

router.patch(
  '/me/status',
  authorize('rider'),
  [body('status').isIn(['offline', 'available', 'on_delivery'])],
  validate,
  async (req, res) => {
    const { status } = req.body;
    try {
      await db.query(
        `UPDATE riders SET status = $1, last_seen_at = NOW() WHERE user_id = $2`,
        [status, req.user.id]
      );

      // Cache availability in Redis for fast nearest-rider queries
      if (status === 'available') {
        await redis.sadd('riders:available', req.user.id);
      } else {
        await redis.srem('riders:available', req.user.id);
      }

      logger.info('Rider status updated', { userId: req.user.id, status });
      return ok(res, { status });
    } catch (err) {
      return serverError(res);
    }
  }
);

// ── PATCH /riders/me/location — real-time GPS update ─────────────────────────

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
    const { latitude, longitude, accuracy } = req.body;
    try {
      // Update DB (throttled — only write to DB every 10th call; use Redis for real-time)
      await db.query(
        `UPDATE riders SET latitude=$1, longitude=$2, last_seen_at=NOW() WHERE user_id=$3`,
        [latitude, longitude, req.user.id]
      );

      // Cache in Redis for WebSocket broadcast (sorted set with geo)
      await redis.geoadd('riders:geo', longitude, latitude, req.user.id);

      // Push location to active delivery watchers
      const activeJob = await redis.get(`rider:active_job:${req.user.id}`);
      if (activeJob) {
        const job = JSON.parse(activeJob);
        await publishOrderEvent(job.order_id, {
          event:    'rider_location_updated',
          riderId:  req.user.id,
          latitude, longitude, accuracy,
        });
      }

      return ok(res, { received: true });
    } catch (err) {
      return serverError(res);
    }
  }
);

// ── GET /riders/jobs/available — jobs awaiting assignment ─────────────────────

router.get('/jobs/available', authorize('rider', 'admin'), async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT dj.id, dj.order_id, dj.pickup_sequence, dj.dropoff_address,
              o.grand_total, o.restaurant_count,
              (SELECT json_agg(so.*) FROM sub_orders so WHERE so.order_id = o.id) AS sub_orders
       FROM delivery_jobs dj
       JOIN orders o ON o.id = dj.order_id
       WHERE dj.status = 'pending_assignment' AND o.status = 'confirmed'
       ORDER BY dj.created_at ASC
       LIMIT 5`
    );
    return ok(res, { jobs: rows });
  } catch (err) {
    return serverError(res);
  }
});

// ── POST /riders/jobs/:jobId/accept ──────────────────────────────────────────

router.post(
  '/jobs/:jobId/accept',
  authorize('rider'),
  async (req, res) => {
    const { jobId } = req.params;
    try {
      // Fetch rider record
      const { rows: [rider] } = await db.query(
        'SELECT * FROM riders WHERE user_id=$1', [req.user.id]
      );
      if (!rider) return notFound(res, 'Rider profile not found');
      if (rider.status !== 'available') {
        return badRequest(res, 'You must be available to accept a job');
      }

      const result = await db.withTransaction(async (client) => {
        // Lock and check job
        const { rows: [job] } = await client.query(
          `SELECT * FROM delivery_jobs WHERE id=$1 AND status='pending_assignment' FOR UPDATE`,
          [jobId]
        );
        if (!job) throw Object.assign(new Error('Job no longer available'), { statusCode: 409 });

        // Assign rider
        await client.query(
          `UPDATE delivery_jobs SET rider_id=$1, status='assigned', assigned_at=NOW() WHERE id=$2`,
          [rider.id, jobId]
        );

        // Update rider status
        await client.query(
          `UPDATE riders SET status='on_delivery' WHERE id=$1`, [rider.id]
        );

        // Advance order status
        await client.query(
          `UPDATE orders SET status='rider_assigned', updated_at=NOW() WHERE id=$1`,
          [job.order_id]
        );

        return job;
      });

      // Cache active job for location broadcasting
      await redis.set(
        `rider:active_job:${req.user.id}`,
        JSON.stringify({ job_id: jobId, order_id: result.order_id }),
        'EX', 86400
      );
      await redis.srem('riders:available', req.user.id);

      // Publish event
      await publishOrderEvent(result.order_id, {
        event:   'rider_assigned',
        orderId: result.order_id,
        jobId,
        riderId: rider.id,
        riderName: req.user.name,
      });

      logger.info('Rider accepted job', { riderId: rider.id, jobId, orderId: result.order_id });
      return ok(res, { job: result, message: 'Job accepted' });
    } catch (err) {
      if (err.statusCode) return badRequest(res, err.message);
      return serverError(res);
    }
  }
);

// ── POST /riders/jobs/:jobId/decline ─────────────────────────────────────────

router.post('/jobs/:jobId/decline', authorize('rider'), async (req, res) => {
  // Log decline — in production, track decline rates to flag low-acceptance riders
  logger.info('Rider declined job', { userId: req.user.id, jobId: req.params.jobId });
  return ok(res, { message: 'Job declined' });
});

// ── PATCH /riders/jobs/:jobId/stop — advance stop state ──────────────────────

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
    const { jobId } = req.params;
    const { stop_index, action, otp } = req.body;

    try {
      const { rows: [job] } = await db.query(
        `SELECT dj.*, o.id AS order_id FROM delivery_jobs dj
         JOIN orders o ON o.id = dj.order_id WHERE dj.id=$1`,
        [jobId]
      );
      if (!job) return notFound(res, 'Job not found');

      const sequence = job.pickup_sequence;
      const stop = sequence[stop_index];
      if (!stop) return badRequest(res, 'Invalid stop index');

      // OTP verification for drops
      if (action === 'dropped') {
        const expectedOtp = await redis.get(`otp:order:${job.order_id}`);
        if (expectedOtp && otp !== expectedOtp) {
          return badRequest(res, 'Incorrect OTP');
        }
      }

      // Determine DB updates based on action
      let jobStatus = 'assigned';
      let orderStatus = null;
      let subOrderStatus = null;

      if (action === 'collected') {
        subOrderStatus = 'picked_up';
        const { sub_order_id } = stop;

        // Check if all pickups done
        const allPicked = sequence
          .filter((s,i) => s.type !== 'drop' && i <= stop_index)
          .every(s => s.type === 'drop' || stop_index >= sequence.indexOf(s));

        if (allPicked) {
          jobStatus = 'collecting';
          orderStatus = 'picked_up';
        }

        if (sub_order_id) {
          await db.query(
            `UPDATE sub_orders SET status='picked_up', picked_up_at=NOW() WHERE id=$1`,
            [sub_order_id]
          );
        }
      }

      if (action === 'dropped') {
        jobStatus = 'delivered';
        orderStatus = 'delivered';

        // Mark all sub-orders as completed via parent order update
        await db.withTransaction(async (client) => {
          await client.query(
            `UPDATE orders SET status='delivered', delivered_at=NOW() WHERE id=$1`,
            [job.order_id]
          );
          await client.query(
            `UPDATE delivery_jobs SET status='delivered', delivered_at=NOW() WHERE id=$1`,
            [jobId]
          );
          await client.query(
            `UPDATE riders SET status='available' WHERE id=(SELECT id FROM riders WHERE user_id=$1)`,
            [req.user.id]
          );
        });

        // Clear active job cache
        await redis.del(`rider:active_job:${req.user.id}`);
        await redis.sadd('riders:available', req.user.id);
      } else {
        await db.query(
          `UPDATE delivery_jobs SET status=$1, updated_at=NOW() WHERE id=$2`,
          [jobStatus, jobId]
        );
      }

      // Publish event
      await publishOrderEvent(job.order_id, {
        event:      'delivery_stop_updated',
        orderId:    job.order_id,
        jobId,
        stop_index,
        action,
        orderStatus,
      });

      return ok(res, { jobId, stop_index, action, jobStatus, orderStatus });
    } catch (err) {
      logger.error('Stop update error', { error: err.message });
      return serverError(res);
    }
  }
);

// ── GET /riders/me/history — completed deliveries ────────────────────────────

router.get('/me/history', authorize('rider'), async (req, res) => {
  const { page = 1, limit = 20 } = req.query;
  const offset = (Math.max(1, +page) - 1) * Math.min(50, +limit);

  try {
    const { rows } = await db.query(
      `SELECT dj.id, dj.order_id, dj.status, dj.delivered_at,
              dj.pickup_sequence,
              o.grand_total, o.restaurant_count,
              -- Rider payout = flat ₹30 per restaurant + ₹5/km (simplified)
              (o.restaurant_count * 3000) AS payout_paise
       FROM delivery_jobs dj
       JOIN orders o ON o.id = dj.order_id
       JOIN riders r ON r.id = dj.rider_id
       WHERE r.user_id=$1 AND dj.status='delivered'
       ORDER BY dj.delivered_at DESC
       LIMIT $2 OFFSET $3`,
      [req.user.id, Math.min(50, +limit), offset]
    );
    return ok(res, { deliveries: rows });
  } catch (err) {
    return serverError(res);
  }
});

// ── GET /riders/me/earnings — earnings summary ───────────────────────────────

router.get('/me/earnings', authorize('rider'), async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT
         COUNT(*) FILTER (WHERE dj.delivered_at >= CURRENT_DATE)            AS trips_today,
         COUNT(*) FILTER (WHERE dj.delivered_at >= date_trunc('week',NOW())) AS trips_week,
         COUNT(*) FILTER (WHERE dj.delivered_at >= date_trunc('month',NOW())) AS trips_month,
         COALESCE(SUM((o.restaurant_count * 3000))
           FILTER (WHERE dj.delivered_at >= CURRENT_DATE), 0)               AS earned_today_paise,
         COALESCE(SUM((o.restaurant_count * 3000))
           FILTER (WHERE dj.delivered_at >= date_trunc('week',NOW())), 0)    AS earned_week_paise,
         COALESCE(SUM((o.restaurant_count * 3000))
           FILTER (WHERE dj.delivered_at >= date_trunc('month',NOW())), 0)   AS earned_month_paise
       FROM delivery_jobs dj
       JOIN orders o ON o.id = dj.order_id
       JOIN riders r ON r.id = dj.rider_id
       WHERE r.user_id=$1 AND dj.status='delivered'`,
      [req.user.id]
    );

    const e = rows[0];
    return ok(res, {
      earnings: {
        today:  { trips: +e.trips_today,  amount_paise: +e.earned_today_paise },
        week:   { trips: +e.trips_week,   amount_paise: +e.earned_week_paise  },
        month:  { trips: +e.trips_month,  amount_paise: +e.earned_month_paise },
      }
    });
  } catch (err) {
    return serverError(res);
  }
});

// ── POST /riders/register — new rider onboarding ─────────────────────────────

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
    const { user_id, vehicle_type, license_no } = req.body;
    try {
      // Promote user to rider role
      await db.query(`UPDATE users SET role='rider' WHERE id=$1`, [user_id]);

      const { rows } = await db.query(
        `INSERT INTO riders (user_id, vehicle_type, license_no)
         VALUES ($1,$2,$3) ON CONFLICT (user_id) DO UPDATE
         SET vehicle_type=EXCLUDED.vehicle_type RETURNING *`,
        [user_id, vehicle_type, license_no || null]
      );
      return created(res, { rider: rows[0] });
    } catch (err) {
      return serverError(res);
    }
  }
);

/**
 * Nearest rider finder utility (used by order service after payment confirmation).
 * Finds available riders within radius_km of a given lat/lng.
 */
async function findNearestRider(latitude, longitude, radiusKm = 10) {
  // GEORADIUS returns riders sorted by distance
  const results = await redis.georadius(
    'riders:geo',
    longitude, latitude,
    radiusKm, 'km',
    'ASC', 'COUNT', 5, 'WITHCOORD', 'WITHDIST'
  );

  if (!results.length) return null;

  // Filter to only truly available riders (cross-check the set)
  for (const [riderId, dist] of results) {
    const isAvailable = await redis.sismember('riders:available', riderId);
    if (isAvailable) {
      return { riderId, distanceKm: parseFloat(dist) };
    }
  }
  return null;
}

module.exports = router;
module.exports.findNearestRider = findNearestRider;
