#!/bin/sh
# Run at connector image build time against the patched guacenc: a recording
# that sets its cursor before the screen has a size (as RDP sessions do) must
# encode, and the result must be a VP9 WebM as long as the recording, with a
# keyframe interval and size as asked. The image does not build if this fails.
set -eu
GUACENC=${GUACENC:-/opt/guacamole/bin/guacenc}
dir=$(mktemp -d)
trap 'rm -rf "$dir"' EXIT

# One Guacamole instruction: each element prefixed by its length.
inst() {
    out=""
    for a in "$@"; do
        out="$out${out:+,}${#a}.$a"
    done
    printf '%s;' "$out"
}

{
    inst cursor 0 0 -1 0 0 32 32
    inst mouse 10 10
    inst sync 1000
    inst size 0 640 480
    inst rect 0 0 0 640 480
    inst cfill 14 0 255 0 0 255
    inst sync 2000
    t=3000
    while [ "$t" -le 12000 ]; do
        inst rect 0 0 0 64 48
        inst cfill 14 0 0 0 $((t / 100 % 256)) 255
        inst sync "$t"
        t=$((t + 1000))
    done
} > "$dir/rec.guac"

"$GUACENC" -f -s 640x480 -r 0 -c libvpx-vp9 -F 10 -g 50 \
    -x "crf=36:qmin=0:qmax=63:deadline=realtime:cpu-used=8" \
    -o "$dir/out.webm" /dev/stdin < "$dir/rec.guac"

codec=$(ffprobe -v error -select_streams v -show_entries stream=codec_name,width,height -of csv=p=0 "$dir/out.webm")
[ "$codec" = "vp9,640,480" ] || { echo "guacenc_test: stream is '$codec'"; exit 1; }
dur=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$dir/out.webm")
awk -v d="$dur" 'BEGIN { exit !(d >= 10.5 && d <= 11.5) }' || { echo "guacenc_test: duration $dur, want ~11"; exit 1; }
keys=$(ffprobe -v error -select_streams v -show_entries packet=flags -of csv=p=0 "$dir/out.webm" | grep -c K)
[ "$keys" -le 3 ] || { echo "guacenc_test: $keys keyframes in 11 s with -g 50"; exit 1; }

# A failed encode says so in its exit status (upstream returned 0).
if "$GUACENC" -f -s 640x480 -c no-such-codec -o "$dir/bad.webm" /dev/stdin < "$dir/rec.guac" 2>/dev/null; then
    echo "guacenc_test: a failed encode exited 0"; exit 1
fi
echo "guacenc_test: ok ($dur s, $keys keyframes)"
