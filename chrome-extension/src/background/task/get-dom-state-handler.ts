/**
 * Get DOM State Handler for MCP Host RPC Requests
 *
 * This file implements the get_dom_state RPC method handler for the browser extension.
 * It responds to requests from the MCP Host that need the current DOM state in a human-readable format.
 */

import type BrowserContext from '../browser/context';
import { createLogger } from '../log';
import type { RpcHandler, RpcRequest, RpcResponse } from '../mcp/host-manager';
import { DOMElementNode } from '../dom/views';
import { DOMService } from '../dom/service';

/**
 * Handler for the 'get_dom_state' RPC method
 *
 * This handler processes DOM state requests from the MCP Host and returns
 * a user-friendly representation of the DOM state.
 */
export class GetDomStateHandler {
  private logger = createLogger('GetDomStateHandler');

  /**
   * Creates a new GetDomStateHandler instance
   *
   * @param browserContext The browser context for accessing DOM state
   */
  constructor(private readonly browserContext: BrowserContext) {}

  /**
   * Handle a get_dom_state RPC request
   *
   * @param request RPC request
   * @returns Promise resolving to an RPC response with the formatted DOM state
   */
  public handleGetDomState: RpcHandler = async (request: RpcRequest): Promise<RpcResponse> => {
    this.logger.debug('Received get_dom_state request:', request);

    try {
      // Get the browser state with vision enabled for better DOM coverage
      const browserState = await this.browserContext.getState(true);

      if (!browserState.elementTree) {
        return {
          error: {
            code: -32000,
            message: 'DOM state not available',
          },
        };
      }

      // Use the same method as Agent to generate human-readable DOM representation
      const interactiveElementsText = browserState.elementTree.clickableElementsToString([
        'role',
        'aria-label',
        'placeholder',
        'name',
        'type',
        'href',
      ]);

      // Add page position markers
      const hasContentAbove = (browserState.pixelsAbove || 0) > 0;
      const hasContentBelow = (browserState.pixelsBelow || 0) > 0;

      let formattedDomText = '';
      if (interactiveElementsText !== '') {
        if (hasContentAbove) {
          formattedDomText = `... ${browserState.pixelsAbove} pixels above - scroll up to see more ...\n${interactiveElementsText}`;
        } else {
          formattedDomText = `[Start of page]\n${interactiveElementsText}`;
        }

        if (hasContentBelow) {
          formattedDomText = `${formattedDomText}\n... ${browserState.pixelsBelow} pixels below - scroll down to see more ...`;
        } else {
          formattedDomText = `${formattedDomText}\n[End of page]\n`;
        }
      } else {
        formattedDomText = 'empty page';
      }

      // Rule of sync: export exactly what was visually highlighted.
      const interactiveElements = this.extractInteractiveElementsFromSelectorMap(browserState.selectorMap);
      const diagnostics = {
        domNodesCount: browserState.diagnostics?.domNodesCount ?? null,
        interactiveCandidateCount: browserState.diagnostics?.interactiveCandidateCount ?? interactiveElements.length,
        visualCount: browserState.diagnostics?.visualCount ?? interactiveElements.length,
        exportCount: browserState.diagnostics?.exportCount ?? interactiveElements.length,
        url: browserState.url,
        permissions: browserState.diagnostics?.permissions ?? 'check',
        warning: browserState.diagnostics?.warning,
        originalSize: browserState.diagnostics?.originalSize,
        payloadSize: browserState.diagnostics?.payloadSize,
        payloadTruncated: browserState.diagnostics?.payloadTruncated,
      };

      if (interactiveElements.length === 0) {
        return {
          result: {
            status: 'error/empty',
            diagnostics,
          },
        };
      }

      const markdownSummary = this.buildComplexDomMarkdownSummary(interactiveElements, browserState.url);

      const isLargePayload = diagnostics.payloadTruncated === true || diagnostics.warning === 'PAYLOAD_TOO_LARGE';

      // Build structured DOM state response
      const domState = {
        status: isLargePayload ? 'ok/large' : 'ok',
        // Human-readable DOM representation
        formattedDom: isLargePayload && markdownSummary ? markdownSummary : formattedDomText,

        // Structured element information
        interactiveElements,

        // Concise markdown summary for complex pages (n8n-friendly)
        markdownSummary,

        // Extraction and payload diagnostics
        diagnostics,

        // For large payloads, keep technical JSON as optional attachment-like block
        technicalData: isLargePayload
          ? {
              interactiveElements,
              formattedDom: formattedDomText,
              diagnostics,
            }
          : undefined,

        // Page metadata
        meta: {
          url: browserState.url,
          title: browserState.title,
          tabId: browserState.tabId,
          pixelsAbove: browserState.pixelsAbove,
          pixelsBelow: browserState.pixelsBelow,
        },
      };

      this.logger.debug('Returning formatted DOM state for MCP host');

      return {
        result: domState,
      };
    } catch (error) {
      this.logger.error('Error getting DOM state:', error);

      return {
        error: {
          code: -32603,
          message: error instanceof Error ? error.message : 'Unknown error retrieving DOM state',
          data: { stack: error instanceof Error ? error.stack : undefined },
        },
      };
    }
  };

  /**
   * Extract interactive elements from the DOM tree
   *
   * @param tree The DOM element tree
   * @returns Array of interactive elements with metadata
   */
  private extractInteractiveElementsFromSelectorMap(selectorMap: Map<number, DOMElementNode>): any[] {
    const interactiveElements: any[] = [];

    const sortedEntries = Array.from(selectorMap.entries()).sort(([a], [b]) => a - b);
    for (const [highlightIndex, node] of sortedEntries) {
      const text = (node.getAllTextTillNextClickableElement() || '').trim();
      interactiveElements.push({
        index: highlightIndex,
        highlightIndex,
        highlightColor: node.highlightColor ?? null,
        highlightColorIndex: node.highlightColorIndex ?? null,
        tagName: node.tagName,
        text,
        label: this.buildPreferredLabel(node, text),
        attributes: { ...node.attributes },
        isInViewport: node.isInViewport,
        selector: node.getEnhancedCssSelector(),
        isNew: node.isNew,
      });
    }

    return interactiveElements;
  }

  private buildPreferredLabel(node: DOMElementNode, text: string): string {
    const trimmedText = (text || '').trim();
    if (trimmedText) {
      return trimmedText;
    }

    const attrs = node.attributes || {};
    const fallback = (attrs['aria-label'] || attrs.title || attrs.placeholder || '').trim();
    const tag = String(node.tagName || 'element').toUpperCase();
    if (fallback) {
      return `${tag} [${fallback}]`;
    }

    return tag;
  }

  private buildComplexDomMarkdownSummary(interactiveElements: any[], url: string): string {
    const highlightedElements = interactiveElements.filter(
      element => Number.isInteger(element.index) && Number(element.index) >= 0,
    );

    const topElements = [...highlightedElements].sort((a, b) => Number(a.index ?? 0) - Number(b.index ?? 0));

    const rows = topElements.map(element => {
      const index = String(element.index ?? '-');
      const type = String(element.tagName ?? '').toLowerCase() || String(element.attributes?.type ?? '-') || '-';

      const primaryLabel = String(element.label || '');
      const rawText = primaryLabel.replace(/\|/g, '\\|').trim();
      const text = rawText.length > 80 ? `${rawText.slice(0, 77)}...` : rawText || '-';

      const idValue = String(element.attributes?.id || '').trim();
      const classValue = String(element.attributes?.class || '').trim();
      const idOrClass = [idValue ? `#${idValue}` : '', classValue ? `.${classValue.replace(/\s+/g, '.')}` : '']
        .filter(Boolean)
        .join(' ')
        .replace(/\|/g, '\\|');

      return `| ${index} | ${type || '-'} | ${text} | ${idOrClass || '-'} |`;
    });

    return [
      '# Radiografia de Elementos Resaltados',
      '',
      `URL: ${url}`,
      `Elementos resaltados: ${highlightedElements.length}`,
      '',
      '| # | Tipo | Texto/Etiqueta | ID/Clase |',
      '| --- | --- | --- | --- |',
      ...rows,
    ].join('\n');
  }
}

export interface DOMStateRequest {
  highlight?: boolean;
  maxElements?: number;
  includeAttributes?: string[];
}

export interface DOMStateResponse {
  url: string;
  title: string;
  viewport: { width: number; height: number };
  elementCount: number;
  selectorMap: Record<string, string>;
  elements: Array<{
    index: number;
    tag: string;
    text: string;
    bounds: {
      x: number;
      y: number;
      width: number;
      height: number;
    };
  }>;
  screenshot?: string;
}

export async function getDomStateHandler(
  page: {
    executeRaw: (scriptTemplate: string, variables?: Record<string, any>) => Promise<any>;
    captureScreenshot: () => Promise<string>;
  },
  params: DOMStateRequest = {},
): Promise<DOMStateResponse> {
  const domService = new DOMService(page);
  const extraction = await domService.extractInteractiveElements();

  let elements = extraction.elements;
  if (params.maxElements && elements.length > params.maxElements) {
    elements = elements.slice(0, params.maxElements);
  }

  if (params.highlight) {
    await injectHighlights(page, elements);
  }

  const selectorMap = elements.reduce(
    (acc, el) => {
      acc[el.index] = el.selector;
      return acc;
    },
    {} as Record<string, string>,
  );

  let screenshot: string | undefined;
  try {
    screenshot = await page.captureScreenshot();
  } catch (e) {
    console.warn('Screenshot failed:', e);
  }

  return {
    url: extraction.url,
    title: extraction.title,
    viewport: extraction.viewport,
    elementCount: elements.length,
    selectorMap,
    elements: elements.map(e => ({
      index: e.index,
      tag: e.tag,
      text: e.text,
      bounds: e.bounds,
    })),
    screenshot,
  };
}

async function injectHighlights(
  page: {
    executeRaw: (scriptTemplate: string, variables?: Record<string, any>) => Promise<any>;
  },
  elements: Array<{
    index: number;
    bounds: { x: number; y: number; width: number; height: number };
  }>,
): Promise<void> {
  const highlightScript = `
    const oldHighlights = document.querySelectorAll('.mcp-highlight-overlay, .mcp-highlight-label');
    oldHighlights.forEach(el => el.remove());

    const elements = __vars.elements;

    elements.forEach((el) => {
      const overlay = document.createElement('div');
      overlay.className = 'mcp-highlight-overlay';
      overlay.style.cssText = [
        'position: fixed',
        'border: 2px solid #ff4444',
        'background: rgba(255, 68, 68, 0.15)',
        'z-index: 2147483646',
        'pointer-events: none',
        'box-sizing: border-box',
      ].join(';');
      overlay.style.left = el.bounds.x + 'px';
      overlay.style.top = el.bounds.y + 'px';
      overlay.style.width = el.bounds.width + 'px';
      overlay.style.height = el.bounds.height + 'px';

      const label = document.createElement('div');
      label.className = 'mcp-highlight-label';
      label.textContent = String(el.index);
      label.style.cssText = [
        'position: fixed',
        'background: #ff4444',
        'color: white',
        'font-family: monospace',
        'font-size: 12px',
        'font-weight: bold',
        'padding: 2px 6px',
        'border-radius: 3px',
        'z-index: 2147483647',
        'pointer-events: none',
      ].join(';');
      label.style.left = el.bounds.x + 'px';
      label.style.top = el.bounds.y - 20 + 'px';

      document.body.appendChild(overlay);
      document.body.appendChild(label);
    });

    return { highlighted: elements.length };
  `;

  await page.executeRaw(highlightScript, { elements });
}
