const { verifyAccessToken } = require("../utils/tokens");

const auth = (req, _res, next) => {
  try {
    const header = req.headers.authorization || "";
    const [scheme, token] = header.split(" ");
    console.log("headers", header);

    if (!token || scheme?.toLowerCase() !== "bearer") {
      const err = new Error("Authorization token missing");
      err.status = 401;
      throw err;
    }

    const decoded = verifyAccessToken(token);
    req.user = decoded;
    next();
  } catch (err) {
    err.status = err.status || 401;
    next(err);
  }
};

module.exports = auth;


