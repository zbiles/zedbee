'use strict';
module.exports = require(process.env.NODE_ENV === 'production' ? './production.cjs' : './development.cjs');
