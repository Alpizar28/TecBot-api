import pino from 'pino';

export const logger = pino({
    name: 'tec-brain-drive',
    level: process.env.LOG_LEVEL ?? 'info',
    timestamp: pino.stdTimeFunctions.isoTime,
});
