// How a task's self-grade looks: a five-axis radar (its area is how much review the task needs), the five grades as
// pips, the attention score and the fit. Read-only; the rubric and the scoring live in grading.ts.
import { Canvas, Text, View } from "nsh";
import { L, lang } from "./i18n";
import { Badge, colors } from "./ui";
import { attention, DIMS, type Fit, type Grade, labels, letters, points, tier } from "./grading";

const zh = () => lang() === "zh";

/** The color of a grade or a tier: the higher, the louder. */
function tone(l: string | null): string {
  return l === "S" ? colors.danger : l === "A" ? colors.warn : l === "B" ? colors.info : colors.faint;
}

const corner = (cx: number, cy: number, r: number, i: number): [number, number] => {
  const a = -Math.PI / 2 + (i * 2 * Math.PI) / DIMS.length;
  return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
};

/** One line a screen reader says for a grade. */
export function gradeSummary(g: Grade): string {
  const t = labels(zh());
  const score = attention(g.grades);
  return [
    `${t.score} ${score === null ? "—" : `${score} ${tier(score)}`}`,
    ...letters(g.grades).map((x, i) => `${t.dims[i]} ${x === "?" ? t.pending : x}`),
    g.fit ? t.fit[g.fit] : "",
  ].filter(Boolean).join(L(", ", "，"));
}

/** How wide an axis label is. */
const LABEL = 72;

/** The radar: five axes, five rings (D to S), the grades as one polygon in the score's tier color. `axes` labels the axes. */
export function GradeRadar(props: { grade: Grade; size: number; axes?: boolean; testID?: string }) {
  // labels need room around the rings
  const pad = () => (props.axes ? 30 : 1.5);
  // the side axes' labels (72 wide, centered on their point) reach past the chart's square: widen the box so they stay
  // inside it instead of spilling into the card's padding
  const side = () => (props.axes ? Math.max(0, Math.ceil(LABEL / 2 - (props.size / 2) * (1 - Math.cos(Math.PI / 10)) - 12 * Math.cos(Math.PI / 10))) : 0);
  return (
    <View testID={props.testID} accessibilityLabel={gradeSummary(props.grade)} style={{ width: props.size + side() * 2, height: props.size, position: "relative" }}>
      <Canvas
        style={{ width: props.size, height: props.size, marginLeft: side() }}
        draw={(cx, s) => {
          const r = Math.min(s.width, s.height) / 2 - pad();
          const mx = s.width / 2, my = s.height / 2;
          const big = !!props.axes;
          cx.strokeStyle = colors.line;
          cx.lineWidth = big ? 1 : 0.75;
          for (let ring = 1; ring <= 5; ring++) {
            if (!big && ring % 2 === 0) continue; // a small chart keeps only D, B and S
            cx.beginPath();
            DIMS.forEach((_, i) => { const [x, y] = corner(mx, my, (r * ring) / 5, i); i ? cx.lineTo(x, y) : cx.moveTo(x, y); });
            cx.closePath();
            cx.stroke();
          }
          if (big) DIMS.forEach((_, i) => { const [x, y] = corner(mx, my, r, i); cx.beginPath(); cx.moveTo(mx, my); cx.lineTo(x, y); cx.stroke(); });
          const color = tone(tier(attention(props.grade.grades)));
          const p = points(props.grade.grades);
          cx.beginPath();
          p.forEach((v, i) => { const [x, y] = corner(mx, my, (r * v) / 5, i); i ? cx.lineTo(x, y) : cx.moveTo(x, y); });
          cx.closePath();
          cx.fillStyle = color;
          cx.globalAlpha = big ? 0.18 : 0.3;
          cx.fill();
          cx.globalAlpha = 1;
          cx.strokeStyle = color;
          cx.lineWidth = big ? 2 : 1.25;
          cx.lineJoin = "round";
          cx.stroke();
          if (big) p.forEach((v, i) => {
            const [x, y] = corner(mx, my, (r * v) / 5, i);
            cx.beginPath();
            cx.arc(x, y, 3, 0, Math.PI * 2);
            cx.fillStyle = v ? color : colors.danger; // a "?" sits at the center, marked
            cx.fill();
          });
        }}
      />
      {props.axes
        ? DIMS.map((_, i) => {
            const half = props.size / 2;
            const [x, y] = corner(half, half, half - 12, i);
            return (
              <Text style={{ position: "absolute", left: side() + x - LABEL / 2, top: y - 9, width: LABEL, textAlign: "center", fontSize: 12, lineHeight: 18, color: colors.muted, numberOfLines: 1 }}>
                {labels(zh()).dims[i]}
              </Text>
            );
          })
        : null}
    </View>
  );
}

/** The score as a number with its tier, in the tier's color. */
function Score(props: { grade: Grade; big?: boolean }) {
  const score = () => attention(props.grade.grades);
  return (
    <View style={{ alignItems: "flex-end" }}>
      <Text style={{ fontSize: props.big ? 24 : 13, lineHeight: props.big ? 28 : 18, fontWeight: "700", color: tone(tier(score())), fontVariant: ["tabular-nums"] }}>
        {score() === null ? "—" : String(score())}
      </Text>
      <Text style={{ fontSize: 11, lineHeight: 14, color: colors.faint }}>{`${labels(zh()).score}${score() === null ? "" : `·${tier(score())}`}`}</Text>
    </View>
  );
}

const fitVariant = (f: Fit) => (f === "right" ? "neutral" : "warn");

function FitBadge(props: { fit?: Fit }) {
  return props.fit ? <Badge label={labels(zh()).fit[props.fit]} variant={fitVariant(props.fit)} size="sm" /> : null;
}

/** One dimension: its name, its letter and five pips. */
function Meter(props: { i: number; letter: string }) {
  const n = () => points(props.letter)[0];
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
      <Text style={{ width: 64, fontSize: 13, color: colors.muted, numberOfLines: 1 }}>{labels(zh()).dims[props.i]}</Text>
      <Text style={{ width: 16, fontSize: 13, fontWeight: "700", color: props.letter === "?" ? colors.danger : tone(props.letter) }}>
        {props.letter === "?" ? labels(zh()).pending : props.letter}
      </Text>
      <View style={{ flexDirection: "row", gap: 2 }}>
        {[1, 2, 3, 4, 5].map((k) => (
          <View style={{ width: 6, height: 12, borderRadius: 1.5, backgroundColor: k <= n() ? tone(props.letter) : colors.line }} />
        ))}
      </View>
    </View>
  );
}

/** A list row's or a message's grade: a small radar, the score and the fit, on one line. */
export function GradeChip(props: { grade: Grade; testID?: string }) {
  return (
    <View testID={props.testID} accessibilityLabel={gradeSummary(props.grade)} style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
      <GradeRadar grade={props.grade} size={20} />
      <Score grade={props.grade} />
    </View>
  );
}

/** Under a task's result in the chat: the grade at a glance, with the fit. */
export function GradeLine(props: { grade: Grade; testID?: string }) {
  const short = () => labels(zh()).short;
  return (
    <View testID={props.testID} accessibilityLabel={gradeSummary(props.grade)} style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 10 }}>
      <GradeRadar grade={props.grade} size={28} />
      <Text style={{ fontSize: 13, fontWeight: "700", color: tone(tier(attention(props.grade.grades))), fontVariant: ["tabular-nums"] }}>
        {`${labels(zh()).score} ${attention(props.grade.grades) ?? "—"}`}
      </Text>
      <Text style={{ fontSize: 12.5, color: colors.muted, fontVariant: ["tabular-nums"] }}>
        {letters(props.grade.grades).map((x, i) => `${short()[i]} ${x === "?" ? labels(zh()).pending : x}`).join("  ")}
      </Text>
      <FitBadge fit={props.grade.fit} />
    </View>
  );
}

/** The task page's grade: the radar beside the five meters, then each grade's evidence. */
export function GradeCard(props: { grade: Grade; wide: boolean }) {
  const t = () => labels(zh());
  const notes = () => props.grade.notes ?? [];
  return (
    <View testID="task-grade" style={{ gap: 12, padding: 14, borderRadius: 12, borderWidth: 1, borderColor: colors.line }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <Text style={{ fontSize: 14, fontWeight: "600", color: colors.text }}>{t().title}</Text>
        <FitBadge fit={props.grade.fit} />
        <View style={{ flex: 1 }} />
        <Score grade={props.grade} big />
      </View>
      <View style={{ flexDirection: props.wide ? "row" : "column", alignItems: "center", gap: props.wide ? 20 : 8 }}>
        <GradeRadar testID="task-grade-radar" grade={props.grade} size={200} axes />
        <View style={{ gap: 8, alignSelf: props.wide ? "center" : "stretch" }}>
          {letters(props.grade.grades).map((x, i) => <Meter i={i} letter={x} />)}
        </View>
      </View>
      {notes().some(Boolean) ? (
        <View style={{ gap: 6 }}>
          {DIMS.map((_, i) => (notes()[i] ? (
            <Text style={{ fontSize: 13.5, lineHeight: 20, color: colors.muted, userSelect: "text" }}>
              <Text style={{ fontWeight: "600", color: colors.text }}>{`${t().dims[i]} ${letters(props.grade.grades)[i] === "?" ? t().pending : letters(props.grade.grades)[i]}${L(": ", "：")}`}</Text>
              {notes()[i]}
            </Text>
          ) : null))}
          {props.grade.fit && notes()[DIMS.length] ? (
            <Text style={{ fontSize: 13.5, lineHeight: 20, color: colors.muted, userSelect: "text" }}>
              <Text style={{ fontWeight: "600", color: colors.text }}>{`${t().fit[props.grade.fit]}${L(": ", "：")}`}</Text>
              {notes()[DIMS.length]}
            </Text>
          ) : null}
        </View>
      ) : null}
      <Text style={{ fontSize: 12, lineHeight: 17, color: colors.faint }}>{t().legend}</Text>
    </View>
  );
}
