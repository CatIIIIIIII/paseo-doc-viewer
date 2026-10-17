import { Text } from "react-native";
import { literalPattern } from "../shared/search";

export function Highlight({ text, query, color }: { text: string; query?: string; color: string }) {
  if (!query) return <>{text}</>;
  const pattern = literalPattern(query);
  const parts = [];
  let offset = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) && parts.length < 1000) {
    parts.push(text.slice(offset, match.index));
    parts.push(<Text key={match.index} style={{ backgroundColor: color }}>{match[0]}</Text>);
    offset = pattern.lastIndex;
  }
  parts.push(text.slice(offset));
  return <>{parts}</>;
}
