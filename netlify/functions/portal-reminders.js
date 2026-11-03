// Scheduled daily (see netlify.toml): registration-deadline reminder emails to portal families.
const S = require('../lib/session');
const portal = require('./portal');

exports.handler = async () => {
  if (!S.configured()) return { statusCode: 503, body: 'not configured' };
  // "Today" in Eastern time.
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  try {
    const sent = await portal.sendRegReminders(today);
    return { statusCode: 200, body: JSON.stringify({ today, sent }) };
  } catch (e) {
    return { statusCode: 500, body: e.message };
  }
};
