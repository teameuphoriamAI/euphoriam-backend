const validate = (schema, payload) => {
  const { error, value } = schema.validate(payload, {
    abortEarly: false,
    stripUnknown: true,
  });

  if (error) {
    const message = error.details.map((d) => d.message).join(", ");
    const err = new Error(message);
    err.status = 400;
    throw err;
  }

  return value;
};

module.exports = validate;



