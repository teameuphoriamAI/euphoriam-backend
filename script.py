import pyautogui
import time
from datetime import datetime

CLICK_INTERVAL = 120  # seconds (2 minutes)

print("Auto-clicker started. It will click every 2 minutes.")
print("Move your mouse to a clickable area before the next click.")
print("Press Ctrl + C to stop.\n")

try:
    while True:
        pyautogui.click()  # performs a left-click at current position
        print(f"[{datetime.now().strftime('%Y-%m-%d %H:%M:%S')}] Mouse clicked.")
        time.sleep(CLICK_INTERVAL)
except KeyboardInterrupt:
    print("\nAuto-clicker stopped by user.")
