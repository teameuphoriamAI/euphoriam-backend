const swaggerUi = require("swagger-ui-express");
const { openapiSpec } = require("./openapiSpec");

const setupSwagger = (app, basePath = "/api/docs") => {
  const jsonPath = `${basePath}/openapi.json`;

  app.get(jsonPath, (_req, res) => {
    res.json(openapiSpec);
  });

  app.use(
    basePath,
    swaggerUi.serve,
    swaggerUi.setup(openapiSpec, {
      customSiteTitle: "Euphoriam Backend API",
      swaggerUrl: jsonPath,
      swaggerOptions: {
        persistAuthorization: true,
        displayRequestDuration: true,
        tryItOutEnabled: true,
        docExpansion: "list",
        filter: true,
      },
      customCss: `
        .swagger-ui .topbar { display: none }
        .swagger-ui .info .title { font-size: 1.6em }
      `,
    }),
  );
};

module.exports = { setupSwagger, openapiSpec };
