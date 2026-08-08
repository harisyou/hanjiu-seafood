export function buildArrivalContactMessage(customerName: string, fishName: string) {
  const greeting = customerName.trim() ? `${customerName.trim()}您好～` : "您好～";
  return `${greeting}之前有登記想找${fishName.trim()}，今天剛好有到貨了！\n如果目前還有需要，歡迎回覆我，我再幫您確認適合的規格與供應狀況 😊`;
}
