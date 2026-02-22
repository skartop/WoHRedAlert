# WoHRedAlert

WoHRedAlert is a Chrome extension designed to provide real-time, read-only alerts for incoming attacks and battles in the browser-based strategy game Ways of History. By monitoring the game's visible state within your browser, it helps players stay informed with timely notifications sent via Telegram or Discord.

## Features

- Monitors incoming fleets and battles targeting your towns.
- Sends notifications to Telegram and Discord channels of your choice.
- Maintains user privacy by securely storing tokens locally in your browser.
- Fully read-only with no automated actions, ensuring compliance with fair play principles.
- Enhances game accessibility by allowing players to receive asynchronous alerts without constant visual monitoring.

## Installation

To install WoHRedAlert from this GitHub repository:

1. Clone or download this repository to your local system.
2. Open Google Chrome and navigate to `chrome://extensions/`.
3. Enable **Developer mode** using the toggle in the top right.
4. Click **Load unpacked** and select the folder containing WoHRedAlert's `manifest.json` and source files.
5. Open your Ways of History game tab in Chrome.
6. Click on the WoHRedAlert extension icon and configure your Telegram bot token, chat ID, and/or Discord webhook URL.
7. Save your settings and wait for alerts.

## Configuration

- **Telegram bot token**: Create a Telegram bot and get its API token to receive notifications.
- **Telegram chat ID**: The chat ID where alerts will be sent.
- **Discord webhook URL**: Optional webhook URL for Discord channel notifications.

## Privacy

WoHRedAlert only reads data visible in your browser's game tab and sends alerts to your configured endpoints. It does not collect or share any other user data.

## Contributing

Contributions are welcome! Please submit issues or pull requests via GitHub.

## License

MIT License — see the LICENSE file for details.
