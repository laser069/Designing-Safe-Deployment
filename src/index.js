require('dotenv').config();
const express = require('express');
const logger = require('./logger');
const routes = require('./routes');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use('/api', routes);

app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok', version: process.env.APP_VERSION });
});

app.use((err, req, res, next) => {
  logger.error('Unhandled error', { message: err.message });
  res.status(500).json({ error: 'Internal server error' });
});

if (require.main === module) {
  app.listen(PORT, () => {
    logger.info(`Orion API started on port ${PORT}`);
  });
}

module.exports = app;
