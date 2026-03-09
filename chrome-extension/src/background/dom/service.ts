import { createLogger } from '@src/background/log';
import type { BuildDomTreeArgs, RawDomTreeNode, BuildDomTreeResult, StageExtractionError } from './raw_types';
import { type DOMState, type DOMBaseNode, type DOMDiagnostics, DOMElementNode, DOMTextNode } from './views';
import type { ViewportInfo } from './history/view';

const logger = createLogger('DOMService');

export interface ReadabilityResult {
  title: string;
  content: string;
  textContent: string;
  length: number;
  excerpt: string;
  byline: string;
  dir: string;
  siteName: string;
  lang: string;
  publishedTime: string;
}

declare global {
  interface Window {
    buildDomTree: (args: BuildDomTreeArgs) => unknown;
    turn2Markdown: (selector?: string) => string;
    parserReadability: () => ReadabilityResult | null;
  }
}

/**
 * Get the markdown content for the current page.
 * @param tabId - The ID of the tab to get the markdown content for.
 * @param selector - The selector to get the markdown content for. If not provided, the body of the entire page will be converted to markdown.
 * @returns The markdown content for the selected element on the current page.
 */
export async function getMarkdownContent(tabId: number, selector?: string): Promise<string> {
  const results = await chrome.scripting.executeScript({
    target: { tabId: tabId },
    func: sel => {
      return window.turn2Markdown(sel);
    },
    args: [selector || ''], // Pass the selector as an argument
  });

  const result = results[0]?.result;
  if (!result) {
    throw new Error('Failed to get markdown content');
  }
  return result as string;
}

/**
 * Get the readability content for the current page.
 * @param tabId - The ID of the tab to get the readability content for.
 * @returns The readability content for the current page.
 */
export async function getReadabilityContent(tabId: number): Promise<ReadabilityResult> {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      return window.parserReadability();
    },
  });
  const result = results[0]?.result;
  if (!result) {
    throw new Error('Failed to get readability content');
  }
  return result as ReadabilityResult;
}

/**
 * Get the clickable elements for the current page.
 * @param tabId - The ID of the tab to get the clickable elements for.
 * @param url - The URL of the page.
 * @param showHighlightElements - Whether to show the highlight elements.
 * @param focusElement - The element to focus on.
 * @param viewportExpansion - The viewport expansion to use.
 * @returns A DOMState object containing the clickable elements for the current page.
 */
export async function getClickableElements(
  tabId: number,
  url: string,
  showHighlightElements = true,
  focusElement = -1,
  viewportExpansion = 0,
  debugMode = false,
): Promise<DOMState> {
  const [elementTree, selectorMap, diagnostics] = await _buildDomTree(
    tabId,
    url,
    showHighlightElements,
    focusElement,
    viewportExpansion,
    debugMode,
  );
  return { elementTree, selectorMap, diagnostics };
}

async function _buildDomTree(
  tabId: number,
  url: string,
  showHighlightElements = true,
  focusElement = -1,
  viewportExpansion = 0,
  debugMode = false,
): Promise<[DOMElementNode, Map<number, DOMElementNode>, DOMDiagnostics]> {
  // If URL is provided and it's about:blank, return a minimal DOM tree
  if (url === 'about:blank') {
    const elementTree = new DOMElementNode({
      tagName: 'body',
      xpath: '',
      attributes: {},
      children: [],
      isVisible: false,
      isInteractive: false,
      isTopElement: false,
      isInViewport: false,
      parent: null,
    });
    return [
      elementTree,
      new Map<number, DOMElementNode>(),
      {
        domNodesCount: 0,
        interactiveCandidateCount: 0,
        url,
        permissions: 'check',
      },
    ];
  }

  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: args => {
      try {
        const domNodesCount = document.querySelectorAll('*').length;
        const payloadLimit = 2 * 1024 * 1024; // 2MB

        const rawResult = window.buildDomTree(args);
        const parsedResult = typeof rawResult === 'string' ? JSON.parse(rawResult) : rawResult;

        if (!parsedResult || typeof parsedResult !== 'object') {
          return {
            error: 'STAGE_EXTRACTION_FAILED',
            detail: 'buildDomTree returned an invalid payload shape',
          };
        }

        const resultObj = parsedResult as Record<string, unknown>;
        const resultMap = (resultObj.map as Record<string, Record<string, unknown>>) || {};
        const rootId = (resultObj.rootId as string) || '';

        const interactiveCandidateCount = Object.values(resultMap).filter(
          node => node && typeof node === 'object' && node.isInteractive === true,
        ).length;

        const meta =
          resultObj.meta && typeof resultObj.meta === 'object' ? (resultObj.meta as Record<string, unknown>) : {};

        meta.domNodesCount = domNodesCount;
        meta.interactiveCandidateCount = interactiveCandidateCount;
        meta.url = location.href;
        meta.permissions = 'check';
        resultObj.meta = meta;

        let payload = JSON.stringify(resultObj);
        let payloadSize = payload.length;
        try {
          payloadSize = new Blob([payload]).size;
        } catch (_e) {
          // Ignore and keep string length fallback
        }

        meta.payloadSize = payloadSize;

        if (payloadSize > payloadLimit) {
          const sampledMap: Record<string, Record<string, unknown>> = {};

          if (rootId && resultMap[rootId]) {
            sampledMap[rootId] = resultMap[rootId];
          }

          const allEntries = Object.entries(resultMap);
          const interactiveEntries = allEntries.filter(
            ([, node]) => node && typeof node === 'object' && node.isInteractive === true,
          );
          const sourceEntries = interactiveEntries.length > 0 ? interactiveEntries : allEntries;

          for (const [id, node] of sourceEntries) {
            if (id === rootId) continue;
            sampledMap[id] = node;
            if (Object.keys(sampledMap).length >= 50) {
              break;
            }
          }

          resultObj.map = sampledMap;
          resultObj.warning = 'PAYLOAD_TOO_LARGE';
          resultObj.originalSize = payloadSize;
          meta.payloadTruncated = true;
          meta.sampledCount = Object.keys(sampledMap).length;
        }

        return JSON.stringify(resultObj);
      } catch (error) {
        const err = error as Error;
        return {
          error: 'STAGE_EXTRACTION_FAILED',
          detail: err?.message || String(error),
          stack: err?.stack,
        };
      }
    },
    args: [
      {
        showHighlightElements,
        focusHighlightIndex: focusElement,
        viewportExpansion,
        debugMode,
      },
    ],
  });

  // First cast to unknown, then to BuildDomTreeResult
  const raw = results[0]?.result as unknown;

  // If the result is a JSON string (serialization fallback), parse it
  let evalPage: BuildDomTreeResult | null = null;
  try {
    if (typeof raw === 'string') {
      evalPage = JSON.parse(raw) as BuildDomTreeResult;
    } else {
      evalPage = raw as BuildDomTreeResult;
    }
  } catch (err) {
    // Provide more diagnostic info when parsing fails
    const snippet =
      typeof raw === 'string' ? `${raw.slice(0, 1024)}...` : JSON.stringify(raw, getCircularReplacer(), 2);
    throw new Error(`Failed to parse DOM tree result: ${String(err)}. Raw snippet: ${snippet}`);
  }

  if (evalPage && 'error' in evalPage && evalPage.error === 'STAGE_EXTRACTION_FAILED') {
    const extractionError = evalPage as unknown as StageExtractionError;
    throw new Error(
      `DOM extraction stage failed: ${extractionError.detail}${extractionError.stack ? `\n${extractionError.stack}` : ''}`,
    );
  }

  if (!evalPage || !evalPage.map || !evalPage.rootId) {
    // If there's no result, include some debugging info from the raw result
    const info = {
      typeofResult: typeof raw,
      resultKeys: raw && typeof raw === 'object' ? Object.keys(raw).slice(0, 10) : undefined,
    };
    throw new Error(
      `Failed to build DOM tree: No result returned or invalid structure. Debug: ${JSON.stringify(info)}`,
    );
  }

  // Log performance metrics in debug mode
  if (debugMode && evalPage.perfMetrics) {
    logger.debug('DOM Tree Building Performance Metrics:', evalPage.perfMetrics);
  }

  const [elementTree, selectorMap] = _constructDomTree(evalPage);

  const diagnostics: DOMDiagnostics = {
    domNodesCount: evalPage.meta?.domNodesCount,
    interactiveCandidateCount: evalPage.meta?.interactiveCandidateCount ?? selectorMap.size,
    url: evalPage.meta?.url ?? url,
    permissions: evalPage.meta?.permissions ?? 'check',
    warning: evalPage.warning,
    originalSize: evalPage.originalSize,
    payloadSize: evalPage.meta?.payloadSize,
    payloadTruncated: evalPage.meta?.payloadTruncated,
  };

  return [elementTree, selectorMap, diagnostics];
}

// Helper to safely stringify objects that may contain circular refs for diagnostics
function getCircularReplacer() {
  const seen = new WeakSet();
  return function (_key: string, value: any) {
    if (typeof value === 'object' && value !== null) {
      if (seen.has(value)) return '[Circular]';
      seen.add(value);
    }
    return value;
  };
}

/**
 * Constructs a DOM tree from the evaluated page data.
 * @param evalPage - The result of building the DOM tree.
 * @returns A tuple containing the DOM element tree and selector map.
 */
function _constructDomTree(evalPage: BuildDomTreeResult): [DOMElementNode, Map<number, DOMElementNode>] {
  const jsNodeMap = evalPage.map;
  const jsRootId = evalPage.rootId;

  const selectorMap = new Map<number, DOMElementNode>();
  const nodeMap: Record<string, DOMBaseNode> = {};

  // First pass: create all nodes
  for (const [id, nodeData] of Object.entries(jsNodeMap)) {
    const [node] = _parse_node(nodeData);
    if (node === null) {
      continue;
    }

    nodeMap[id] = node;

    // Add to selector map if it has a highlight index
    if (node instanceof DOMElementNode && node.highlightIndex !== undefined && node.highlightIndex !== null) {
      selectorMap.set(node.highlightIndex, node);
    }
  }

  // Second pass: build the tree structure
  for (const [id, node] of Object.entries(nodeMap)) {
    if (node instanceof DOMElementNode) {
      const nodeData = jsNodeMap[id];
      const childrenIds = 'children' in nodeData ? nodeData.children : [];

      for (const childId of childrenIds) {
        if (!(childId in nodeMap)) {
          continue;
        }

        const childNode = nodeMap[childId];

        childNode.parent = node;
        node.children.push(childNode);
      }
    }
  }

  const htmlToDict = nodeMap[jsRootId];

  if (htmlToDict === undefined || !(htmlToDict instanceof DOMElementNode)) {
    throw new Error('Failed to parse HTML to dictionary');
  }

  return [htmlToDict, selectorMap];
}

/**
 * Parse a raw DOM node and return the node object and its children IDs.
 * @param nodeData - The raw DOM node data to parse.
 * @returns A tuple containing the parsed node and an array of child IDs.
 */
export function _parse_node(nodeData: RawDomTreeNode): [DOMBaseNode | null, string[]] {
  if (!nodeData) {
    return [null, []];
  }

  // Process text nodes immediately
  if ('type' in nodeData && nodeData.type === 'TEXT_NODE') {
    const textNode = new DOMTextNode(nodeData.text, nodeData.isVisible, null);
    return [textNode, []];
  }

  // At this point, nodeData is RawDomElementNode (not a text node)
  // TypeScript needs help to narrow the type
  const elementData = nodeData as Exclude<RawDomTreeNode, { type: string }>;

  // Process viewport info if it exists
  let viewportInfo: ViewportInfo | undefined = undefined;
  if ('viewport' in nodeData && typeof nodeData.viewport === 'object' && nodeData.viewport) {
    const viewportObj = nodeData.viewport as { width: number; height: number };
    viewportInfo = {
      width: viewportObj.width,
      height: viewportObj.height,
      scrollX: 0,
      scrollY: 0,
    };
  }

  const elementNode = new DOMElementNode({
    tagName: elementData.tagName,
    xpath: elementData.xpath,
    attributes: elementData.attributes ?? {},
    children: [],
    isVisible: elementData.isVisible ?? false,
    isInteractive: elementData.isInteractive ?? false,
    isTopElement: elementData.isTopElement ?? false,
    isInViewport: elementData.isInViewport ?? false,
    highlightIndex: elementData.highlightIndex ?? null,
    shadowRoot: elementData.shadowRoot ?? false,
    parent: null,
    viewportInfo: viewportInfo,
  });

  const childrenIds = elementData.children || [];

  return [elementNode, childrenIds];
}

export async function removeHighlights(tabId: number): Promise<void> {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        // Remove the highlight container and all its contents
        const container = document.getElementById('playwright-highlight-container');
        if (container) {
          container.remove();
        }

        // Remove highlight attributes from elements
        const highlightedElements = document.querySelectorAll('[browser-user-highlight-id^="playwright-highlight-"]');
        for (const el of Array.from(highlightedElements)) {
          el.removeAttribute('browser-user-highlight-id');
        }
      },
    });
  } catch (error) {
    logger.error('Failed to remove highlights:', error);
  }
}

/**
 * Get the scroll information for the current page.
 * @param tabId - The ID of the tab to get the scroll information for.
 * @returns A tuple containing the number of pixels above and below the current scroll position.
 */
export async function getScrollInfo(tabId: number): Promise<[number, number]> {
  const results = await chrome.scripting.executeScript({
    target: { tabId: tabId },
    func: () => {
      const scroll_y = window.scrollY;
      const viewport_height = window.innerHeight;
      const total_height = document.documentElement.scrollHeight;
      return {
        pixels_above: scroll_y,
        pixels_below: total_height - (scroll_y + viewport_height),
      };
    },
  });

  const result = results[0]?.result;
  if (!result) {
    throw new Error('Failed to get scroll information');
  }
  return [result.pixels_above, result.pixels_below];
}
