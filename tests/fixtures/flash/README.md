HUD crops from the locally supplied `src-video/예시녹화본1.mp4` (2560×1440).
No complete video frames or player camera images are stored here.

Captured using the same grayscale multi-region sampling path as analysis:

- `ready.png`: F slot, source 285 s.
- `used.png`, `used-half.png`, `countdown.png`: F slot, source 291, 291.5, 292 s.
- `dead.png`: F slot disabled without a cooldown, source 1530 s.
- `occluded.png`: source 690 s, the HUD is covered.
- `other-spell.png`: D slot, source 120 s; not Flash.

The engine reference `engine/assets/flash-ready.png` is the F-slot crop at source 180 s.

`tf-yone-ready-search.png` is a 44×44 HUD-only crop from `트페vs요네.mp4`
(1920×1080), source 100 s, at pixel (1019, 981). The 28×28 ready icon
aligns at (3, 11) inside this crop; the former configured position was (8, 8).
