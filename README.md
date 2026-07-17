# Rocketman

Rocketman is a Windows desktop control center for launching and monitoring local projects.

## Desktop App

Install with:

```bat
release\Rocketman Setup 0.1.0.exe
```

Rocketman creates a desktop shortcut and starts with Windows in the notification area. Closing or minimizing the window hides it without stopping project servers. Use the tray menu to reopen it, toggle startup, or quit completely.

The dashboard runs at:

```text
http://localhost:7777
```

Project configuration and desktop state are stored under `%APPDATA%\Rocketman`.

## Development

Run the local Node dashboard with:

```bat
run.cmd
```

Run the desktop shell during development with:

```bat
npm run desktop
```

Build a new Windows installer with:

```bat
npm run desktop:build
```

## Project Management

Projects can be added and removed from the Projects tab. Removing a project does not delete its source files. Project cards reconcile against live local listeners, automatically detect configured projects started outside Rocketman, and show the next available port when a preferred port is occupied.

Unmatched Node and Python listeners appear as ghost cards. Use **Add to Rocketman** to prefill a project configuration from a discovered listener.

Vision OCR, Overwriting Detection, and Fraud Test use their configured conda environments. Rocketman opens project URLs in Google Chrome.

## Verification

```bat
npm run verify:management
npm run verify:discovery
npm run verify:visual
```
