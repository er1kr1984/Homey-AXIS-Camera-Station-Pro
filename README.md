# Camera Station Live (Homey app)

Live video from AXIS Camera Station Pro in Homey over WebRTC: no camera RTSP, no transcoding.

How it works:
- **Login:** logs in to ACS's built-in login service (AXIS IAM on-prem, OAuth2 PKCE), the same way the ACS web client does.
- **Camera list:** read from ACS's GraphQL API (`/api/graphql`).
- **Opening a camera:** Homey's frontend sends an SDP offer. `lib/live-relay.js` then:
  1. answers it with a werift peer connection;
  2. opens a live session on `wss://<acs>/webrtc/signal-server/client`;
  3. answers ACS's own offer with a second peer connection;
  4. forwards the H.264 RTP packets between the two.
- **Still image:** comes from the documented `SnapshotFacade/GetSnapshot` API on port 29204.

Protocol notes: `~/acspro-webrtc/FINDINGS-homey-webrtc.md`.

Local end-to-end test (a fake viewer instead of Homey):

    ACS_USER=... ACS_PASS=... node test/relay-live.js "<camera name part>" 10
