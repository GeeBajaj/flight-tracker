// Site settings. proxyUrl points at a deployed copy of worker/ (see README), which
// adds the site owner's API key so visitors don't need their own. Leave it empty
// to have every visitor enter their own key in Settings.
window.FLIGHT_TRACKER_CONFIG = {
  proxyUrl: 'https://flight-tracker-proxy.recipe-parser.workers.dev',
};
