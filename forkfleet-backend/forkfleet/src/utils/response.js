/**
 * Send a successful JSON response.
 */
const ok = (res, data = {}, statusCode = 200) =>
  res.status(statusCode).json({ success: true, data });

/**
 * Send a created response (201).
 */
const created = (res, data = {}) =>
  res.status(201).json({ success: true, data });

/**
 * Send an error response with a human-readable message.
 */
const error = (res, message, statusCode = 500, details = null) => {
  const body = { success: false, message };
  if (details && process.env.NODE_ENV !== 'production') body.details = details;
  return res.status(statusCode).json(body);
};

const badRequest  = (res, msg = 'Bad request', details)    => error(res, msg, 400, details);
const unauthorized= (res, msg = 'Unauthorized')             => error(res, msg, 401);
const forbidden   = (res, msg = 'Forbidden')                => error(res, msg, 403);
const notFound    = (res, msg = 'Not found')                => error(res, msg, 404);
const conflict    = (res, msg = 'Conflict')                 => error(res, msg, 409);
const serverError = (res, msg = 'Internal server error')    => error(res, msg, 500);

module.exports = { ok, created, error, badRequest, unauthorized, forbidden, notFound, conflict, serverError };
