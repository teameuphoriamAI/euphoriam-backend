const Joi = require("joi");

module.exports = Joi.object({
  scheduledAt: Joi.date().iso().optional(),
  durationMinutes: Joi.number().integer().positive().optional(),
  notes: Joi.alternatives(Joi.object(), Joi.string()).optional(),
  coachId: Joi.number().integer().optional(),
});


