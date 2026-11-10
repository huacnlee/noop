// A message's images at full size: a lazy chunk, loaded the first time one is opened (lazy.tsx). NSH's Carousel
// comes with it, and on the web its part of the runtime.
import { Image, signal, Text, View, type ViewStyle } from "nsh";
import { Carousel, CarouselContent, CarouselItem, CarouselNext, CarouselPrevious, Dialog } from "nsh/base";
import { L } from "./i18n";
import { alpha, Icon } from "./ui";
import { mediaUrl } from "./hub";
import type { Hub } from "./connection";

export function ImagePreview(props: { hub: Hub; paths: string[]; start: number; open: boolean; onClose: () => void }) {
  return (
    <Dialog
      open={props.open}
      animation="fade"
      onOpenChange={({ open }) => !open && props.onClose()}
      backdropClass="bg-scrim"
      style={{ flex: 1, padding: 24, pointerEvents: "box-none" }}
    >
      <ImagePager hub={props.hub} paths={props.paths} start={props.start} onClose={props.onClose} />
    </Dialog>
  );
}

/**
 * A message's images full size, paged in a loop (NSH's `Carousel`): swipe, the arrow keys or the side buttons move
 * on, past the last back to the first; a press on the image closes it.
 */
function ImagePager(props: { hub: Hub; paths: string[]; start: number; onClose: () => void }) {
  const index = signal(props.start);
  const many = props.paths.length > 1;
  const side = (left: boolean): ViewStyle => ({
    position: "absolute", top: "50%", marginTop: -20, [left ? "left" : "right"]: 8, width: 40, height: 40, borderRadius: 20,
    alignItems: "center", justifyContent: "center", backgroundColor: alpha("#000000", 0.45), cursor: "pointer",
  });
  return (
    <Carousel index={index()} looping onChange={({ index: i }) => index.set(i)} accessibilityLabel={L("Images", "图片")} style={{ flex: 1 }}>
      <CarouselContent style={{ flex: 1 }}>
        <Each of={props.paths}>
          {(p, i) => (
            <CarouselItem accessibilityLabel={`${i() + 1} / ${props.paths.length}`} style={{ width: "100%", height: "100%" }}>
              <View testID="image-preview" accessibilityLabel={L("Close image", "关闭大图")} onPress={props.onClose} style={{ flex: 1, alignItems: "center", justifyContent: "center", cursor: "zoom-out" }}>
                <Image src={mediaUrl(props.hub.cfg.url, props.hub.cfg.token, p())} style={{ width: "100%", height: "100%", objectFit: "contain" }} />
              </View>
            </CarouselItem>
          )}
        </Each>
      </CarouselContent>
      <If when={many}>
        <CarouselPrevious testID="image-prev" accessibilityLabel={L("Previous image", "上一张")} style={side(true)}><Icon name="back" size={18} tint="#ffffff" /></CarouselPrevious>
        <CarouselNext testID="image-next" accessibilityLabel={L("Next image", "下一张")} style={side(false)}><Icon name="chevron" size={18} tint="#ffffff" /></CarouselNext>
        <View style={{ position: "absolute", bottom: 8, alignSelf: "center", paddingHorizontal: 10, height: 24, borderRadius: 12, justifyContent: "center", backgroundColor: alpha("#000000", 0.45) }}>
          <Text style={{ fontSize: 12, color: "#ffffff", fontVariant: ["tabular-nums"] }}>{`${index() + 1} / ${props.paths.length}`}</Text>
        </View>
      </If>
    </Carousel>
  );
}
