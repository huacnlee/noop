// An attached image at full size: a lazy chunk, loaded the first time one is opened (lazy.tsx).
import { Image, View } from "nsh";
import { Dialog } from "nsh/base";
import { L } from "./i18n";

export function ImagePreview(props: { src: string; open: boolean; onClose: () => void }) {
  return (
    <Dialog
      open={props.open}
      animation="fade"
      onOpenChange={({ open }) => !open && props.onClose()}
      backdropClass="bg-scrim"
      style={{ flex: 1, padding: 24, pointerEvents: "box-none" }}
    >
      <View testID="image-preview" accessibilityLabel={L("Close image", "关闭大图")} onPress={props.onClose} style={{ flex: 1, alignItems: "center", justifyContent: "center", cursor: "zoom-out" }}>
        <Image src={props.src} style={{ width: "100%", height: "100%", objectFit: "contain" }} />
      </View>
    </Dialog>
  );
}
