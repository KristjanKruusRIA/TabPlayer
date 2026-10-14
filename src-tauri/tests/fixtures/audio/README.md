The four tone fixtures are authored test data, released under CC0-1.0.
They contain a mono 440 Hz sine at 44,100 Hz for 0.25 seconds. They were encoded
independently using FFmpeg 7.1, with:

`ffmpeg -f lavfi -i sine=frequency=440:sample_rate=44100:duration=0.25 -ac 1 tone.EXT`

Extensions are wav (PCM16), flac, mp3, and ogg (Vorbis). Tests derive duration,
channel count and frequency independently of the production decoder.
