import logger from "../logger.js";

export const errorHandler = (err, req, res, next) => {
    logger.error(`Error: ${err}`);
    console.error(err);
    const statusCode = err.statusCode || 500;
    const message = "Oops! There is something went wrong! Please Try Again. "  ;

    res.status(statusCode).json({
        status: 0,
        code: statusCode,
        message: message
    });
};
