import log4js from 'log4js';
const { configure, getLogger } = log4js;

const LOG_LEVEL = 'info';

// Configuration Block
configure({
    appenders: {
        // Output logs to the console
        console: { 
            type: 'console',
            layout: { type: 'pattern', pattern: '[%d] [%p] %f{1}:%l - %m%n' }
        }
    },
    categories: {
        // Default logger for general application use
        default: { appenders: ['console'], level: LOG_LEVEL, enableCallStack: true },
    }
});

// Export the loggers you need for the rest of your application
export const logger = getLogger(); // The default logger
export const dbLogger = getLogger('database'); // The named 'database' logger
