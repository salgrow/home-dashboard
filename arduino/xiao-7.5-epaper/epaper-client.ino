/*
 * XIAO 7.5" ePaper Panel - Smart Dashboard Display
 * 
 * USE AT YOUR OWN RISK. THIS CODE IS PROVIDED AS-IS WITHOUT WARRANTY.
 * YOU MAY HAVE TO ADJUST THE CODE TO SUIT YOUR SPECIFIC HARDWARE.
 * PLEASE DOUBLE CHECK YOUR HARDWARE AND UNDERSTAND THIS CODE BEFORE UPLOADING.
 * 
 * FEATURES:
 * - Downloads and displays 1 bit color PNG images from HTTP server
 * - Light sleep between refreshes (preserves display state, fast wake)
 * - Deep sleep during night hours (12am-5am for maximum battery savings)
 * - NTP time synchronization for accurate scheduling
 * - Ghosting prevention with inverse refresh technique
 * - Automatic retry on download failures
 * 
 * TESTED HARDWARE:
 * - XIAO ESP32-C3 microcontroller
 * - 7.5" ePaper display (800x480, monochrome)
 * - 2000mAh LiPo battery
 * 
 * REQUIRED LIBRARIES:
 * - PNGdec by Larry Bank (Arduino Library Manager)
 * - Seeed_Arduino_LCD (GitHub: https://github.com/Seeed-Studio/Seeed_Arduino_LCD)
 * 
 * CONFIGURATION:
 * - Double check driver.h for display settings
 * - Set WiFi credentials below
 * - Set server IP and port
 * - Adjust timezone offset for your location
 * 
 * AUTHOR: Kyle Turman
 * LICENSE: MIT
 * VERSION: 1.0.0
 */

#include <WiFi.h>
#include <HTTPClient.h>
#include <PNGdec.h>
#include <TFT_eSPI.h>
#include <time.h>
 
// ==================== CONFIGURATION ====================
 
// WiFi configuration
const char* WIFI_SSID = "{{WIFI_NAME}}";
const char* WIFI_PASSWORD = "{{WIFI_PASSWORD}}";

// Server configuration
const char* SERVER_IP = "{{SERVER_IP}}";
const int SERVER_PORT = {{SERVER_PORT}};

// Main dashboard image path
const char* IMAGE_PATH = "/dashboard/image";
 
// Time configuration (used for deep sleep scheduling)
const long GMT_OFFSET_SEC = -28800;      // PST (UTC-8). Adjust for your timezone
const int DAYLIGHT_OFFSET_SEC = 3600;    // Add 1 hour if DST active, 0 otherwise
const int DEEP_SLEEP_START_HOUR = 0;     // Enter deep sleep at midnight
const int DEEP_SLEEP_END_HOUR = 5;       // Wake from deep sleep at 5am
const char* NTP_SERVER = "pool.ntp.org";
 
// Display configuration
const unsigned long REFRESH_INTERVAL = 600000;  // 10 minutes in milliseconds
const int CONNECT_TIMEOUT = 20000;              // WiFi connection timeout (ms)
const int HTTP_TIMEOUT = 45000;                 // HTTP request timeout (ms)

// ==================== HARDWARE CONFIGURATION ====================
// Display settings - adjust these for different display sizes
#define DISPLAY_WIDTH 800
#define DISPLAY_HEIGHT 480

// CPU Frequency (MHz) - Lower = better battery life
// Options: 160, 80, 40, 20, 10
// 80MHz recommended for good balance of speed and power efficiency
#define CPU_FREQ_MHZ 80

// ==================== DEBUG CONFIGURATION ====================
// Set to 1 to enable serial debugging, 0 for production (saves power)
#define DEBUG_ENABLED 1

#if DEBUG_ENABLED
  #define DEBUG_PRINT(x) Serial.print(x)
  #define DEBUG_PRINTLN(x) Serial.println(x)
  #define DEBUG_PRINTF(...) Serial.printf(__VA_ARGS__)
#else
  #define DEBUG_PRINT(x)
  #define DEBUG_PRINTLN(x)
  #define DEBUG_PRINTF(...)
#endif


// ==================== RTC MEMORY ====================
// Variables stored in RTC memory persist through light sleep but reset on deep sleep

RTC_DATA_ATTR int bootCount = 0;              // Total number of boots/wakes
RTC_DATA_ATTR bool timeInitialized = false;   // Whether NTP time has been synced
RTC_DATA_ATTR unsigned long lastWakeTime = 0; // Unix timestamp of last wake

// ==================== GLOBAL VARIABLES ====================

PNG png;                    // PNG decoder instance
EPaper epaper;              // ePaper display instance
bool displayInitialized = false;  // Track if display hardware is initialized

// PNG buffer (allocated dynamically during download)
uint8_t* pngBuffer = nullptr;
size_t pngBufferSize = 0;
int renderLine = 0;

// ==================== FUNCTION DECLARATIONS ====================

// PNG decoding
void decodePNG();
int pngDrawCallback(PNGDRAW* pDraw);

// Network functions
bool connectWiFi();
bool downloadPNG();

// Time management
bool syncTimeWithNTP();
bool isDeepSleepTime(int hour);
unsigned long getSecondsUntil5AM(int currentHour, int currentMinute);

// Display functions
void updateDisplay();
void showStatusMessage(const char* message, bool isError = false);

// ==================== SETUP ====================
 
void setup() {
  #if DEBUG_ENABLED
    Serial.begin(115200);
    delay(1000);
  #endif

  // Set CPU frequency for power optimization
  setCpuFrequencyMhz(CPU_FREQ_MHZ);

  bootCount++;
  esp_sleep_wakeup_cause_t wakeup_reason = esp_sleep_get_wakeup_cause();

  DEBUG_PRINTLN("\n========================================");
  DEBUG_PRINTLN("XIAO ePaper Smart Display");
  DEBUG_PRINTLN("========================================");
  DEBUG_PRINTF("Boot #%d | Free Memory: %d bytes\n", bootCount, ESP.getFreeHeap());
  DEBUG_PRINTF("CPU Frequency: %d MHz\n", getCpuFrequencyMhz());

  // Determine if this is a deep sleep wake (requires full display initialization)
  bool wokeFromDeepSleep = (wakeup_reason == ESP_SLEEP_WAKEUP_TIMER && !displayInitialized);

  if (wokeFromDeepSleep || bootCount == 1) {
    DEBUG_PRINTLN("Cold boot or deep sleep wake - initializing display hardware");
    
    // Initialize ePaper display
    epaper.begin();
    epaper.fillScreen(TFT_WHITE);
    epaper.update();  // Clear the screen first
    delay(1000);      // Give user a moment to see the clear screen
     
    epaper.setTextColor(TFT_BLACK);
    epaper.setTextSize(1);  // 12px font (6x8 base * 1 = ~12px effective)
     
    // Show initialization message
    showStatusMessage("Initializing...");
     
    displayInitialized = true;
     
    // Sync time with NTP server after deep sleep (RTC was reset)
    if (!timeInitialized) {
      showStatusMessage("Connecting...");

      if (connectWiFi()) {
        showStatusMessage("Syncing time...");
        syncTimeWithNTP();
        timeInitialized = true;
        WiFi.disconnect(true);
        WiFi.mode(WIFI_OFF);
        delay(500);
      } else {
        showStatusMessage("WiFi failed", true);
        delay(3000);  // Show error for 3 seconds
        DEBUG_PRINTLN("WARNING: NTP sync failed - time may be inaccurate");
      }
    }
  } else {
    // Light sleep wake - display state preserved, just wake it up
    DEBUG_PRINTLN("Light sleep wake - display state preserved");
    epaper.wake();
  }
   
  DEBUG_PRINTLN("Initialization complete\n");
}
 
// ==================== MAIN LOOP ====================
 
 void loop() {
  DEBUG_PRINTLN("--- Refresh Cycle Start ---");

  // Get current time and check if we should enter deep sleep mode
  struct tm timeinfo;
  if (getLocalTime(&timeinfo)) {
    unsigned long currentTime = mktime(&timeinfo);
    DEBUG_PRINTF("Current time: %02d:%02d:%02d\n", 
                  timeinfo.tm_hour, timeinfo.tm_min, timeinfo.tm_sec);

    // Log if we missed a wake cycle (debugging)
    if (lastWakeTime > 0 && (currentTime - lastWakeTime) > (REFRESH_INTERVAL * 2 / 1000)) {
      DEBUG_PRINTF("WARNING: Missed expected wake by %lu seconds\n", 
                    currentTime - lastWakeTime - (REFRESH_INTERVAL / 1000));
    }
    lastWakeTime = currentTime;

    // Check if it's night time (12am-5am) - enter deep sleep for battery savings
    if (isDeepSleepTime(timeinfo.tm_hour)) {
      unsigned long sleepSeconds = getSecondsUntil5AM(timeinfo.tm_hour, timeinfo.tm_min);

      DEBUG_PRINTF("Night mode: Entering deep sleep for %lu seconds (until 5am)\n", sleepSeconds);
      DEBUG_PRINTLN("Display will reinitialize on wake\n");
       
#if DEBUG_ENABLED
  Serial.flush();
#endif
       
      // Ensure complete WiFi shutdown
      WiFi.disconnect(true);
      WiFi.mode(WIFI_OFF);
      delay(500);
       
      // Put display in sleep mode
      epaper.sleep();
       
      // Mark that we need to reinitialize after deep sleep
      displayInitialized = false;
      timeInitialized = false;
       
      // Configure timer and enter deep sleep (ultra-low power ~10-20µA)
      esp_sleep_enable_timer_wakeup(sleepSeconds * 1000000ULL);
      esp_deep_sleep_start();
      // Device resets on wake - execution never continues past this point
    }
  } else {
    DEBUG_PRINTLN("WARNING: Failed to get local time");
  }
   
  // Normal operation during active hours - download and display image
  bool downloadSuccess = false;
   
  // Show loading message only on first boot
  if (bootCount == 1) {
    showStatusMessage("Loading dashboard...");
  }
   
  // Try downloading with retry logic (helps with transient network issues)
  for (int attempt = 1; attempt <= 2 && !downloadSuccess; attempt++) {
    if (attempt > 1) {
      DEBUG_PRINTF("Retry attempt %d/2\n", attempt);
      if (bootCount == 1) {
        showStatusMessage("Retrying download...");
      }
      delay(5000);
    }
     
    if (connectWiFi() && downloadPNG()) {
      downloadSuccess = true;
      updateDisplay();
    }
  }
   
  if (!downloadSuccess) {
    DEBUG_PRINTLN("ERROR: All download attempts failed");
    if (bootCount == 1) {
      showStatusMessage("Download failed", true);
      delay(5000);  // Show error for 5 seconds before sleeping
    }
  }
   
  // Critical: Ensure WiFi is completely shut down before sleep
  // This prevents WiFi interference with the sleep timer
  WiFi.disconnect(true);
  WiFi.mode(WIFI_OFF);
  delay(500);
  
  // Put display in low-power sleep mode
  epaper.sleep();
  
  // Prepare for light sleep
  DEBUG_PRINTF("Entering light sleep for %lu minutes\n", REFRESH_INTERVAL / 60000);
  DEBUG_PRINTLN("--- Refresh Cycle End ---\n");
   
#if DEBUG_ENABLED
  Serial.flush();
#endif
  
  // Clear any previous wakeup sources and configure timer
  esp_sleep_disable_wakeup_source(ESP_SLEEP_WAKEUP_ALL);
  esp_err_t timer_err = esp_sleep_enable_timer_wakeup(REFRESH_INTERVAL * 1000ULL);
   
  if (timer_err != ESP_OK) {
    DEBUG_PRINTF("CRITICAL ERROR: Failed to configure timer wakeup (err: %d)\n", timer_err);
    DEBUG_PRINTLN("Restarting device...\n");
     
#if DEBUG_ENABLED
    Serial.flush();
#endif

    delay(5000);
    ESP.restart();
  }
   
  // Enter light sleep (preserves RAM and display state, ~0.8mA)
  esp_err_t sleep_result = esp_light_sleep_start();
   
  // === Wake up - execution continues here ===
   
  if (sleep_result == ESP_OK) {
    DEBUG_PRINTLN("\n========================================");
    DEBUG_PRINTLN("Woke from light sleep");
     
    // Verify we woke from the timer (not something unexpected)
    esp_sleep_wakeup_cause_t wakeup_cause = esp_sleep_get_wakeup_cause();
    if (wakeup_cause != ESP_SLEEP_WAKEUP_TIMER) {
      DEBUG_PRINTF("WARNING: Unexpected wake source: %d\n", wakeup_cause);
    }
     
     // Wake display from sleep mode
    epaper.wake();
  } else {
    // Light sleep failed - this is critical, restart the device
    DEBUG_PRINTF("CRITICAL ERROR: Light sleep failed (err: %d)\n", sleep_result);
    DEBUG_PRINTLN("Restarting device...\n");
     
#if DEBUG_ENABLED
    Serial.flush();
#endif
 
    delay(5000);
    ESP.restart();
  }
}

// ==================== DISPLAY FUNCTIONS ====================

/**
* Update the ePaper display with the downloaded PNG image
* Uses inverse refresh technique to prevent ghosting
*/
void updateDisplay() {
  if (pngBuffer == nullptr || pngBufferSize == 0) {
    DEBUG_PRINTLN("ERROR: No image data to display");
    return;
  }
  
  DEBUG_PRINTLN("Updating display...");
  epaper.wake();
  
  // Step 1: Decode PNG into display buffer (doesn't update screen yet)
  epaper.fillScreen(TFT_WHITE);
  decodePNG();
  
  // Free PNG buffer - we're done with it
  free(pngBuffer);
  pngBuffer = nullptr;
  pngBufferSize = 0;
  
  // Step 2: Anti-ghosting technique - show inverse image briefly
  // This resets ePaper particles to prevent ghost images from previous content
  uint8_t* buf = (uint8_t*)epaper.frameBuffer(0);
  int bufSize = (DISPLAY_WIDTH * DISPLAY_HEIGHT) / 8;
  
  // Invert all bits in the buffer
  for (int i = 0; i < bufSize; i++) {
    buf[i] = ~buf[i];
  }
  epaper.update();
  delay(200);  // Brief flash of inverse image
  
  // Step 3: Restore and display the actual image
  // Invert back to original
  for (int i = 0; i < bufSize; i++) {
    buf[i] = ~buf[i];
  }
  epaper.update();
  
  delay(2000);  // Allow display to fully settle
  DEBUG_PRINTLN("Display updated successfully");
}

/**
* Decode PNG data from memory into the ePaper display buffer
*/
void decodePNG() {
  int result = png.openRAM(pngBuffer, pngBufferSize, pngDrawCallback);
  
  if (result != PNG_SUCCESS) {
    DEBUG_PRINTF("ERROR: Failed to open PNG (code: %d)\n", result);
    return;
  }
  
  DEBUG_PRINTF("Decoding PNG: %dx%d pixels\n", png.getWidth(), png.getHeight());
  
  if (png.getWidth() != DISPLAY_WIDTH || png.getHeight() != DISPLAY_HEIGHT) {
    DEBUG_PRINTF("WARNING: Size mismatch! Expected %dx%d\n", DISPLAY_WIDTH, DISPLAY_HEIGHT);
  }
  
  renderLine = 0;
  result = png.decode(nullptr, 0);
  
  if (result != PNG_SUCCESS) {
    DEBUG_PRINTF("ERROR: PNG decode failed (code: %d)\n", result);
  }
  
  png.close();
}

/**
* PNG decoder callback - called for each line of the image
* Handles 1-bit, 2-bit, 4-bit, and 8-bit indexed PNGs
* For 1-bit PNGs, pixels are packed 8 per byte
* 
* IMPORTANT: Server should provide indexed PNG format
* - 800x480 pixels
* - 1-bit, 2-bit, 4-bit or 8-bit indexed color
* - 2-color palette for 1-bit (black and white)
*/
int pngDrawCallback(PNGDRAW* pDraw) {
  int y = pDraw->y;
  int width = pDraw->iWidth;
  
  // Verify this is an indexed PNG
  if (pDraw->iPixelType != PNG_PIXEL_INDEXED) {
    DEBUG_PRINTLN("ERROR: PNG must be indexed format!");
    return 0;  // Stop decoding
  }
  
  uint8_t* pixels = (uint8_t*)pDraw->pPixels;
  uint8_t* palette = (uint8_t*)pDraw->pPalette;
  int bpp = pDraw->iBpp;  // Bits per pixel (1, 2, 4, or 8)
  
  // Process each pixel in this line
  for (int x = 0; x < width && x < DISPLAY_WIDTH; x++) {
    uint8_t paletteIndex;
    
    // Extract palette index based on bit depth
    if (bpp == 8) {
      // 8-bit: one pixel per byte
      paletteIndex = pixels[x];
    } else if (bpp == 4) {
      // 4-bit: two pixels per byte
      int byteIndex = x / 2;
      int pixelInByte = x % 2;
      paletteIndex = (pixels[byteIndex] >> (pixelInByte == 0 ? 4 : 0)) & 0x0F;
    } else if (bpp == 2) {
      // 2-bit: four pixels per byte
      int byteIndex = x / 4;
      int pixelInByte = x % 4;
      paletteIndex = (pixels[byteIndex] >> (6 - pixelInByte * 2)) & 0x03;
    } else {  // bpp == 1
      // 1-bit: eight pixels per byte (MSB first)
      int byteIndex = x / 8;
      int bitInByte = x % 8;
      paletteIndex = (pixels[byteIndex] >> (7 - bitInByte)) & 0x01;
    }
    
    // Get RGB color from palette
    uint16_t color;
    if (palette != nullptr && paletteIndex < 256) {
      uint8_t r = palette[paletteIndex * 3];
      uint8_t g = palette[paletteIndex * 3 + 1];
      uint8_t b = palette[paletteIndex * 3 + 2];
      
      // Calculate luminosity - brightness > 127 = white, else black
      uint8_t brightness = (r * 299 + g * 587 + b * 114) / 1000;
      color = (brightness > 127) ? TFT_WHITE : TFT_BLACK;
    } else {
      // Invalid palette - default to white
      color = TFT_WHITE;
    }
    
    // Draw pixel to ePaper buffer
    if (y < DISPLAY_HEIGHT && x < DISPLAY_WIDTH) {
      epaper.drawPixel(x, y, color);
    }
  }
  
  renderLine++;
  return 1;  // Continue decoding
}

// ==================== NETWORK FUNCTIONS ====================

/**
* Connect to WiFi network with timeout
* @return true if connected successfully, false on timeout
*/
bool connectWiFi() {
  DEBUG_PRINTF("Connecting to WiFi: %s...", WIFI_SSID);
  
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  
  unsigned long start = millis();
  while (WiFi.status() != WL_CONNECTED) {
    if (millis() - start > CONNECT_TIMEOUT) {
      DEBUG_PRINTLN(" TIMEOUT");
      return false;
    }
    delay(500);
    DEBUG_PRINT(".");
  }
  
  DEBUG_PRINTF(" Connected (IP: %s)\n", WiFi.localIP().toString().c_str());
  return true;
}

/**
* Download PNG image from HTTP server into memory
* @return true if download successful, false on error
*/
bool downloadPNG() {
  String url = String("http://") + SERVER_IP + ":" + SERVER_PORT + IMAGE_PATH;
  DEBUG_PRINTF("Downloading: %s\n", url.c_str());
  
  HTTPClient http;
  http.setTimeout(HTTP_TIMEOUT);
  http.begin(url);
  
  int httpCode = http.GET();
  
  if (httpCode != HTTP_CODE_OK) {
    DEBUG_PRINTF("ERROR: HTTP request failed (code: %d)\n", httpCode);
    http.end();
    return false;
  }
  
  int contentLength = http.getSize();
  DEBUG_PRINTF("Content length: %d bytes\n", contentLength);
  
  // Validate content length
  if (contentLength <= 0 || contentLength > 150000) {
    DEBUG_PRINTLN("ERROR: Invalid content length");
    http.end();
    return false;
  }
  
  // Allocate buffer for PNG data
  pngBuffer = (uint8_t*)malloc(contentLength);
  if (!pngBuffer) {
    DEBUG_PRINTF("ERROR: Failed to allocate %d bytes\n", contentLength);
    http.end();
    return false;
  }
  
  pngBufferSize = contentLength;
  
  // Download data
  WiFiClient* stream = http.getStreamPtr();
  size_t bytesRead = 0;
  
  while (http.connected() && bytesRead < contentLength) {
    size_t available = stream->available();
    if (available) {
      size_t toRead = min(available, contentLength - bytesRead);
      size_t got = stream->readBytes(pngBuffer + bytesRead, toRead);
      bytesRead += got;
    }
    delay(1);
  }
  
  http.end();
  
  if (bytesRead != contentLength) {
    DEBUG_PRINTF("ERROR: Download incomplete (%d/%d bytes)\n", bytesRead, contentLength);
    free(pngBuffer);
    pngBuffer = nullptr;
    pngBufferSize = 0;
    return false;
  }
  
  DEBUG_PRINTLN("Download complete");
  return true;
}

// ==================== TIME MANAGEMENT ====================

/**
* Synchronize device time with NTP server
* @return true if sync successful, false on failure
*/
bool syncTimeWithNTP() {
  DEBUG_PRINTLN("Syncing time with NTP server...");
  
  configTime(GMT_OFFSET_SEC, DAYLIGHT_OFFSET_SEC, NTP_SERVER);
  
  // Wait up to 10 seconds for time sync
  struct tm timeinfo;
  int retries = 10;
  while (!getLocalTime(&timeinfo) && retries > 0) {
    delay(1000);
    retries--;
  }
  
  if (retries > 0) {
#if DEBUG_ENABLED
    Serial.println(&timeinfo, "Time synchronized: %A, %B %d %Y %H:%M:%S");
#endif
    return true;
  } else {
    DEBUG_PRINTLN("ERROR: NTP sync timeout");
    return false;
  }
}

/**
* Check if current hour is during deep sleep period (12am-5am)
* @param hour Current hour (0-23)
* @return true if in deep sleep period
*/
bool isDeepSleepTime(int hour) {
  return (hour >= DEEP_SLEEP_START_HOUR && hour < DEEP_SLEEP_END_HOUR);
}

/**
* Calculate seconds until 5:00 AM from current time
* @param currentHour Current hour (0-23)
* @param currentMinute Current minute (0-59)
* @return Seconds until 5:00 AM (with 2-minute buffer)
*/
unsigned long getSecondsUntil5AM(int currentHour, int currentMinute) {
  int hoursUntil5AM;
  
  if (currentHour < DEEP_SLEEP_END_HOUR) {
    // Same day - hours until 5am
    hoursUntil5AM = DEEP_SLEEP_END_HOUR - currentHour;
  } else {
    // Next day - hours until midnight + 5 hours
    hoursUntil5AM = (24 - currentHour) + DEEP_SLEEP_END_HOUR;
  }
  
  // Convert to seconds, subtract current minutes, add 2-minute buffer
  unsigned long seconds = (hoursUntil5AM * 3600) - (currentMinute * 60) + 120;
  
  return seconds;
}

// ==================== DISPLAY HELPER FUNCTIONS ====================

/**
* Show status message in bottom left corner during initialization
* Only displays on first boot to provide user feedback
* Position: 20px from left, 12px from bottom
* Font: 12px (1x scale of built-in font)
* 
* @param message Text to display
* @param isError If true, shows error styling (optional)
*/
void showStatusMessage(const char* message, bool isError) {
  const int MSG_X = 12;
  const int MSG_Y = DISPLAY_HEIGHT - 20;  // Adjusted for better positioning
  const int CLEAR_WIDTH = 300;   // Width to clear for text area
  const int CLEAR_HEIGHT = 20;   // Height to clear
  
  // Clear the message area (white rectangle)
  epaper.fillRect(0, MSG_Y - 2, DISPLAY_WIDTH, CLEAR_HEIGHT, TFT_WHITE);

  // Set text properties
  epaper.setTextColor(TFT_BLACK);
  epaper.setTextSize(1.75);
  epaper.setCursor(MSG_X, MSG_Y);
  
  // Draw the message
  if (isError) {
    epaper.print("ERROR: ");
  }
  epaper.print(message);
  
  // Update display to show the message
  epaper.update();
  
  // Small delay so user can see the message
  delay(500);
  
  DEBUG_PRINTF("Status: %s%s\n", isError ? "ERROR: " : "", message);
}
