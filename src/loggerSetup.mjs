import pkg from 'log4js';
const { configure, getLogger } = pkg;

// Configuration Block
configure({
    appenders: {
        // Output logs to the console
        console: { 
            type: 'console',
            layout: { type: 'pattern', pattern: '[%d] [%p] %f{1}:%l - %m%n' }
        }/*,
        // Output logs to a rolling file
        appFile: {
            type: 'dateFile', 
            filename: 'logs/app', 
            pattern: 'yyyy-MM-dd.log',
            maxLogSize: 1024 * 1024 * 5, // 5MB
            numBackups: 3
        }
	*/
    },
    categories: {
        // Default logger for general application use
	    default: { appenders: ['console'], level: 'info', enableCallStack: true },
        // Specific logger for database interactions
//        database: { appenders: ['appFile', 'console'], level: 'debug' } 
    }
});

// Export the loggers you need for the rest of your application
export const logger = getLogger(); // The default logger
export const dbLogger = getLogger('database'); // The named 'database' logger

// Optional: Export specific levels for direct use if needed, though generally discouraged
// export const info = logger.info.bind(logger);
