/**
 * E-paper Display Driver Configuration
 *
 * Configuration for e-paper display with Seeed GFX library.
 * Use https://seeed-studio.github.io/Seeed_GFX/ to generate configuration.
 *
 * Add or uncomment your display as needed.
 *
 */

#if CONFIG_IDF_TARGET_ESP32C3
  // XIAO 7.5 inch monochrome ePaper Screen（UC8179）
  #define BOARD_SCREEN_COMBO 502
  #define USE_XIAO_EPAPER_DRIVER_BOARD

#elif CONFIG_IDF_TARGET_ESP32S3
  // reTerminal E1001 (7.5" Monochrome) - Default
  #define BOARD_SCREEN_COMBO 520
  
  // Uncomment for reTerminal E1002 (7.3" Full Color)
  // #define BOARD_SCREEN_COMBO 521
  
#else
  #error "Unsupported board - select XIAO_ESP32C3 or XIAO_ESP32S3"
#endif
