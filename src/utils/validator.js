const Joi = require("joi");

exports.createPromptSchemaValidator = Joi.object({
  name: Joi.string().required(),
  type: Joi.string().required(),
  content: Joi.string().required(),
  isActive: Joi.boolean().optional(),
});
