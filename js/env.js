// Environment checks that change what the app can honestly offer.
//
// Browsers only expose the camera in a "secure context" — https, or localhost.
// Served over plain http on a home network (which is how you'd first try this
// on a phone), navigator.mediaDevices is simply undefined. Without saying so,
// every camera feature looks broken for no visible reason.

export function cameraUnavailableReason() {
  if (typeof window === 'undefined') return 'unsupported';
  if (!window.isSecureContext) return 'insecure';
  if (!navigator.mediaDevices?.getUserMedia) return 'unsupported';
  return null;
}

export const CAMERA_MESSAGES = {
  insecure: 'The camera needs an https connection — browsers block it over plain http, which is how this page is being served. Choosing a photo from your gallery works fine, and so does everything else.',
  unsupported: 'This browser doesn’t give web pages camera access. Choose a photo instead.',
};

export function cameraMessage() {
  const reason = cameraUnavailableReason();
  return reason ? CAMERA_MESSAGES[reason] : null;
}
