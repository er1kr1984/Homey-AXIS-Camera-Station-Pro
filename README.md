# Camera Station Live (Homey app)

Live video, events and control for AXIS Camera Station Pro in Homey. Video uses Camera
Station's own WebRTC service: no camera RTSP, no transcoding.

## Devices
- **Camera**: live video (WebRTC), picture, motion alarm, camera offline alarm, manual recording button.
  Quality: Low (default), Medium, High or Automatic (lowers quality when Homey gets busy).
- **View**: a Camera Station split view as one picture laid out like the view's grid,
  refreshed every minute by default.

## Flow cards
- When: *Camera Station sent an event* (per camera, with snapshot), *Camera Station sent an event*
  (app-wide, any source), motion alarm, camera offline alarm.
- And: *Manual recording is on*, *Camera is online*.
- Then: *Take a snapshot* (camera or view, gives an image for notifications), *Start/Stop manual recording*,
  *Add bookmark*, *Move to PTZ preset*, *Activate / Deactivate / Pulse / Activate for a while* a
  Camera Station trigger.

## Sending events from Camera Station to Homey
1. Open the camera in Homey, tap the cog, and copy **Address for Camera Station events**.
2. In the Camera Station client: Configuration > Recording and events > Action rules > New.
3. Trigger: e.g. *Motion detection* for that camera. Action: *Send HTTP notification*, method GET,
   paste the address. Camera Station fills in `$(TriggerData.Type)` and `$(TriggerData.TimeUtc)`.
4. For other events (door station, action button, input) use the same address; remove
   `&event=motion` if the rule is not about motion. POST with a JSON body containing
   `Type`, `SourceId`, `SourceName`, `TimeUtc` also works.

The address contains a secret key; Homey ignores requests without it.

## How the video works
Login is Camera Station's own login service (OAuth2 PKCE). Homey's frontend and Camera Station
both send the WebRTC offer, so `lib/live-relay.js` answers both with two werift peer connections
and forwards the H.264 packets. One Camera Station stream per camera is shared by all viewers.
`lib/werift-tuning.js` makes werift's per-packet work cheaper (see its tests).

Protocol notes: `~/acspro-webrtc/FINDINGS-homey-webrtc.md`.

## Tests
    npm test                                   # unit tests
    TUNE=1 RATE=200 node bench/relay-bench.js  # relay CPU with a fixed synthetic load
    ACS_USER=... ACS_PASS=... node test/relay-multi.js "<camera>" medium 3 5
    ACS_USER=... ACS_PASS=... node test/switch.js "<camera>" medium low
