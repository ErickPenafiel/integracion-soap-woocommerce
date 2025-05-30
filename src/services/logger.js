// logger.js
const { createLogger, format, transports } = require("winston");

const logger = createLogger({
	level: "info",
	format: format.combine(
		format.timestamp(),
		format.printf(
			(info) =>
				`${info.timestamp} [${info.level.toUpperCase()}]: ${info.message}`
		)
	),
	transports: [
		new transports.File({ filename: "logs/error.log", level: "error" }),
		new transports.File({ filename: "logs/combined.log" }),
		new transports.Console(), // También muestra en consola
	],
});

module.exports = logger;
