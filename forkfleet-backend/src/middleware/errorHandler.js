const logger = require('../utils/logger');

// Catch express-validator errors from validationResult
const { validationResult } = require('express-validator');

const validate = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({
      success: false,
      message: 'Validation failed',
      errors: errors.array().map(e => ({ field: e.path, message: e.msg })),
    });
  }
  next();
};

// eslint-disable-next-line no-unused-vars
const globalErrorHandler = (err, req, res, next) => {
  const statusCode = err.statusCode || 500;
  const message    = err.message    || 'Internal server error';

  logger.error('Unhandled error', {
    message,
    statusCode,
    stack: err.stack,
    path: req.path,
    method: req.method,
    userId: req.user?.id,
  });

  res.status(statusCode).json({
    success: false,
    message: process.env.NODE_ENV === 'production' && statusCode === 500
      ? 'Internal server error'
      : message,
  });
};

const notFoundHandler = (req, res) => {
  res.status(404).json({ success: false, message: `Route ${req.method} ${req.path} not found` });
};

module.exports = { validate, globalErrorHandler, notFoundHandler };
