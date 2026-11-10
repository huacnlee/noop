/** The head of a page (a task, a memory file): its title block, set apart from the body by a hairline. */
import type { JSX, ViewStyle } from "nsh";
import { View } from "nsh";
import { colors } from "./theme";

export function PageHeader(props: { testID?: string; style?: ViewStyle; children?: JSX.Element }) {
  return (
    <View testID={props.testID} style={[{ gap: 8, paddingBottom: 20, marginBottom: 20, borderBottomWidth: 1, borderBottomColor: colors.line }, props.style ?? null]}>
      {props.children}
    </View>
  );
}
