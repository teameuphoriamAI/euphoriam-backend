const Joi = require("joi");

const userSchema = Joi.object({
  email: Joi.string().email().lowercase().required(),
  name: Joi.string().min(2).max(100).required(),
  password: Joi.string().min(8).max(12).required(),
  role: Joi.string().valid("user", "admin").default("user"),
  metadata: Joi.object().default({}).optional(),
});

module.exports = userSchema;


