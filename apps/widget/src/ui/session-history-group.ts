/** @internal Calendar days in the viewer's timezone; DST never changes a group boundary. */
function sessionHistoryGroup(createdAt: string, now: Date = new Date()): string {
  const date = new Date(createdAt);
  if (!Number.isFinite(date.getTime())) return "Trước đây";
  const day = (value: Date) => Date.UTC(value.getFullYear(), value.getMonth(), value.getDate());
  const age = (day(now) - day(date)) / 86_400_000;
  if (age <= 0) return "Hôm nay";
  if (age === 1) return "Hôm qua";
  if (age <= 7) return "Gần đây";
  if (age <= 30) return "30 ngày trước";
  return `Tháng ${date.getMonth() + 1}${date.getFullYear() === now.getFullYear() ? "" : ` năm ${date.getFullYear()}`}`;
}
