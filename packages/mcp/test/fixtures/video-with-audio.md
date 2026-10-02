video-with-audio.mp4 is a generated two-second H.264/AAC test pattern with a 440 Hz tone. It contains no third-party media. Regenerate with:

ffmpeg -f lavfi -i testsrc2=size=160x160:rate=20 -f lavfi -i sine=frequency=440:sample_rate=48000 -t 2 -c:v libx264 -pix_fmt yuv420p -crf 30 -c:a aac -b:a 64k -movflags +faststart video-with-audio.mp4
