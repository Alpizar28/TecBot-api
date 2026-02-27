import 'dotenv/config';
import { buildServer } from './server.js';

const PORT = parseInt(process.env.PORT ?? '3001', 10);
const HOST = process.env.HOST ?? '0.0.0.0';

const server = buildServer();

server.listen({ port: PORT, host: HOST }, (err, address) => {
    if (err) {
        server.log.error(err);
        process.exit(1);
    }
    server.log.info(`Scraper Service started at ${address}`);
});

process.on('SIGTERM', async () => {
    await server.close();
    process.exit(0);
});
process.on('SIGINT', async () => {
    await server.close();
    process.exit(0);
});
