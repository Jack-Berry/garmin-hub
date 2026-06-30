#!/bin/bash
# Tear down the Garmin Hub local always-on test deployment.
# Stops + removes the three launchd services. Logs are left in place.
LA="$HOME/Library/LaunchAgents"

for l in api web daily; do
  launchctl unload -w "$LA/com.garminhub.$l.plist" 2>/dev/null || true
  rm -f "$LA/com.garminhub.$l.plist"
  echo "removed com.garminhub.$l"
done

echo
echo "Uninstalled. Logs left in ~/Library/Logs/garmin-hub-*.log and"
echo "~/garmin-hub-cron.log — delete manually if you want them gone."
