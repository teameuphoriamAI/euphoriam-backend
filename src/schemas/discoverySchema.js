const Joi = require("joi");

module.exports = Joi.object({
  title: Joi.string().max(255).optional(),
  data: Joi.object().required(),
});


