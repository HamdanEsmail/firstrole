/** The documented TinyFish viewer is read-only. Keep its URL out of persistent client state. */
export function safeAgentPreviewUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 4096 || !/^https:\/\/[a-z\d.-]+\//i.test(value))
    return null;
  try {
    const url = new URL(value);
    const documentedViewer =
      /^tf-[a-z\d]+(?:-[a-z\d]+)*\.[a-z\d]+(?:-[a-z\d]+)*-tinyfish\.unikraft\.app$/i.test(
        url.hostname,
      ) && /^\/stream\/\d+$/.test(url.pathname);
    // Also observed in authenticated live run metadata on 2026-09-30.
    const productionHost =
      /^ip-(\d{1,3})-(\d{1,3})-(\d{1,3})-(\d{1,3})\.tetra-data\.production\.tinyfish\.io$/i.exec(
        url.hostname,
      );
    const productionViewer =
      Boolean(productionHost && productionHost.slice(1).every((part) => Number(part) <= 255)) &&
      /^\/tf-[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}\/stream\/\d+$/i.test(
        url.pathname,
      );
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      url.port ||
      url.hash ||
      !(documentedViewer || productionViewer)
    )
      return null;
    return url.href;
  } catch {
    return null;
  }
}
