---
title: Use it on your phone
description: Open your ZumiBot server on a phone, add it to the home screen, and turn on notifications so you know when an agent needs you.
sidebar:
  order: 8
---

There is no ZumiBot phone app. Instead, you open your server in the phone's browser and add it to the home screen, where it opens like an app. Then notifications tell you when an agent needs an answer or has finished.

You need a [ZumiBot server](/get-started/install-server/). A desktop app in Local mode runs only on its own computer, so a phone cannot reach it.

## Add it to the home screen

1. On the phone, open your server's address in the browser, for example `https://zumibot.example.com`.
2. Sign in with your password and a 6-digit code. You stay signed in for 30 days.
3. Add it to the home screen:
   - **iPhone or iPad:** use Safari. Tap the Share button, then **Add to Home Screen**.
   - **Android:** use Chrome. Open the menu, then choose **Install app** or **Add to Home screen**.
4. Open ZumiBot from the new icon.

## Turn on notifications

The steps below are the short version. [Notifications](/connect/notifications/) explains every event and when a notification is held back.

1. Open the sidebar with the menu button at the top left, then choose Settings (the gear), then Notifications.
2. Under "This device", choose **Enable**. The browser asks for permission. Allow it.
3. Choose **Send test**. A test notification should show on the phone in a moment.
4. Choose which events notify you. Each has its own switch:
   - **Needs you**: an agent waits for an approval or an answer, or a spend cap paused a run.
   - **Replied**: an agent finished its reply.
   - **Reply error**: a reply ended with an error.
   - **A routine or workflow failed**: a routine or workflow run failed.

Tapping a notification opens that chat. A notification only opens the chat. It never answers a card for you.

On an iPhone, notifications work only after you add ZumiBot to the Home Screen. Until you do, the status reads "On iPhone, add ZumiBot to the Home Screen first".

## Tips and limits

- Notifications carry the chat's title only. They never include your messages, commands or file paths.
- You get no notification for the chat you are looking at, and none while someone has that chat open on another device.
- On a phone, Enter in the message box starts a new line. Use the round send button to send. The keyboard stays open after you send, so you can keep typing.
- If the status reads "Blocked by the browser", allow notifications for the site in the browser's settings, then come back and choose **Enable**.
- If it reads "Paused: signed out", sign in again and choose **Enable**.
- If it reads "Not supported", this browser cannot do push notifications.
- Every browser or phone you enable is listed under "Other devices" in the same settings page. Choose **Remove** to take one off.

## Related

- [Install on a server](/get-started/install-server/)
- [First-run setup](/get-started/first-run-setup/)
- [Your first chat](/get-started/first-chat/)
- [Voice requests](/voice/voice-requests/)
- [Notifications](/connect/notifications/)
- [Telegram and Slack](/connect/telegram-and-slack/)
