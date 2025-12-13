const requireRole = (roles = []) => {
  const allowed = Array.isArray(roles) ? roles : [roles];

  return (req, _res, next) => {
    if (!req.user) {
      const err = new Error("Not authenticated");
      err.status = 401;
      return next(err);
    }

    if (allowed.length && !allowed.includes(req.user.role)) {
      const err = new Error("Forbidden");
      err.status = 403;
      return next(err);
    }

    next();
  };
};

module.exports = requireRole;



