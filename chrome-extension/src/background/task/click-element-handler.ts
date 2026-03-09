/**
 * Click Element Handler for MCP Host RPC Requests
 *
 * This file implements the click_element RPC method handler for the browser extension.
 * It responds to requests from the MCP Host that need to click interactive elements on pages.
 */

import type BrowserContext from '../browser/context';
import { createLogger } from '../log';
import type { RpcHandler, RpcRequest, RpcResponse } from '../mcp/host-manager';
import { findElementByHighlightIndex } from './dom-utils';
import type { DOMElementNode } from '../dom/views';

/**
 * Handler for the 'click_element' RPC method
 *
 * This handler processes click requests from the MCP Host and performs
 * clicks on interactive elements identified by their index.
 */
export class ClickElementHandler {
  private logger = createLogger('ClickElementHandler');

  /**
   * Creates a new ClickElementHandler instance
   *
   * @param browserContext The browser context for accessing page interaction methods
   */
  constructor(private readonly browserContext: BrowserContext) {}

  /**
   * Handle a click_element RPC request
   *
   * @param request RPC request with click parameters
   * @returns Promise resolving to an RPC response confirming the click action
   */
  public handleClickElement: RpcHandler = async (request: RpcRequest): Promise<RpcResponse> => {
    this.logger.debug('Received click_element request:', request);

    try {
      const { element_index, wait_after } = request.params || {};

      // Validate element_index parameter
      if (element_index === undefined || element_index === null) {
        return {
          error: {
            code: -32602,
            message: 'Missing required parameter: element_index',
          },
        };
      }

      if (typeof element_index !== 'number' || element_index < 0) {
        return {
          error: {
            code: -32602,
            message: 'element_index must be a non-negative number',
          },
        };
      }

      // Validate wait_after parameter if provided
      const waitAfter = wait_after || 1;
      if (typeof waitAfter !== 'number' || waitAfter < 0 || waitAfter > 30000) {
        return {
          error: {
            code: -32602,
            message: 'wait_after must be a number between 0 and 30000 milliseconds',
          },
        };
      }

      // Get current page
      const currentPage = await this.browserContext.getCurrentPage();
      if (!currentPage) {
        return {
          error: {
            code: -32000,
            message: 'No active page available',
          },
        };
      }

      // Store current URL for comparison
      const beforeUrl = await this.getCurrentUrl(currentPage);

      // Perform the click operation
      const clickResult = await this.clickElement(currentPage, element_index);

      // Wait for the specified time after clicking
      await new Promise(resolve => setTimeout(resolve, waitAfter));

      // Check if page changed after click
      const afterUrl = await this.getCurrentUrl(currentPage);
      const pageChanged = beforeUrl !== afterUrl;

      const result = {
        success: true,
        message: `Successfully clicked element at index ${element_index}`,
        element_index,
        page_changed: pageChanged,
        element_info: clickResult.elementInfo,
        before_url: beforeUrl,
        after_url: afterUrl,
      };

      this.logger.debug('Click element completed:', result);

      return {
        result,
      };
    } catch (error) {
      this.logger.error('Error clicking element:', error);

      let errorCode = 'CLICK_FAILED';
      let errorMessage = 'Failed to click element';

      if (error instanceof Error) {
        errorMessage = error.message;

        // Classify error types
        if (error.message.includes('not found')) {
          errorCode = 'ELEMENT_NOT_FOUND';
        } else if (error.message.includes('not clickable')) {
          errorCode = 'ELEMENT_NOT_CLICKABLE';
        } else if (error.message.includes('timeout')) {
          errorCode = 'CLICK_TIMEOUT';
        } else if (error.message.includes('detached')) {
          errorCode = 'ELEMENT_DETACHED';
        }
      }

      return {
        error: {
          code: -32603,
          message: errorMessage,
          data: {
            error_code: errorCode,
            stack: error instanceof Error ? error.stack : undefined,
          },
        },
      };
    }
  };

  /**
   * Click an element by its index
   *
   * @param page The page instance to interact with
   * @param elementIndex The index of the element to click
   * @returns Promise resolving to click result with element information
   */
  private async clickElement(
    page: any,
    elementIndex: number,
  ): Promise<{
    elementInfo: any;
  }> {
    // Get the DOM element by highlightIndex using shared utility
    const domElement = await findElementByHighlightIndex(page, elementIndex);
    if (!domElement) {
      throw new Error(`Element with highlightIndex ${elementIndex} not found in DOM state`);
    }

    // Extract element information for response
    const elementInfo = {
      tag_name: domElement.tagName,
      text: domElement.getAllTextTillNextClickableElement() || domElement.attributes.value || '',
      type: domElement.attributes.type,
      role: domElement.attributes.role,
      aria_label: domElement.attributes['aria-label'],
      class: domElement.attributes.class,
      id: domElement.attributes.id,
    };

    // Locate the element on the page
    const elementHandle = await page.locateElement(domElement);
    if (!elementHandle) {
      throw new Error(`Element with index ${elementIndex} could not be located on the page`);
    }

    // Check if element is visible and clickable
    const isVisible = await page.safeEvaluate(elementHandle, (el: Element) => {
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      return (
        rect.width > 0 &&
        rect.height > 0 &&
        style.visibility !== 'hidden' &&
        style.display !== 'none' &&
        style.opacity !== '0'
      );
    });

    if (!isVisible) {
      throw new Error(`Element with index ${elementIndex} is not visible or clickable`);
    }

    // Scroll element into view if needed
    await page.safeEvaluate(elementHandle, (el: Element) => {
      el.scrollIntoView({
        behavior: 'instant',
        block: 'center',
        inline: 'center',
      });
    });

    // Wait a moment for scroll to complete
    await new Promise(resolve => setTimeout(resolve, 100));

    // Perform the click
    try {
      await elementHandle.click();
      this.logger.debug(`Successfully clicked element at index ${elementIndex}`, elementInfo);
    } catch (clickError) {
      // If normal click fails, try JavaScript click as fallback
      this.logger.error(`Normal click failed for element ${elementIndex}, trying JavaScript click`, clickError);

      await page.safeEvaluate(elementHandle, (el: HTMLElement) => {
        el.click();
      });

      this.logger.debug(`JavaScript click succeeded for element at index ${elementIndex}`, elementInfo);
    }

    return {
      elementInfo,
    };
  }

  /**
   * Get the current URL of the page
   *
   * @param page The page instance
   * @returns Promise resolving to the current URL
   */
  private async getCurrentUrl(page: any): Promise<string> {
    try {
      if (page._puppeteerPage) {
        return await page._puppeteerPage.url();
      }
      return 'unknown';
    } catch (error) {
      this.logger.error('Failed to get current URL:', error);
      return 'unknown';
    }
  }
}

export interface ClickRequest {
  selector?: string;
  index?: number;
  selectorMap?: Record<string, string>;
  waitForNavigation?: boolean;
  timeout?: number;
}

export interface ClickResult {
  success: boolean;
  selectorUsed?: string;
  elementInfo?: {
    tag: string;
    text: string;
    bounds: any;
  };
  error?: string;
  preCheck?: {
    exists: boolean;
    visible?: boolean;
    rect?: any;
    tag?: string;
    text?: string;
  };
}

export async function clickElementHandler(
  page: {
    executeRaw: (scriptTemplate: string, variables?: Record<string, any>) => Promise<any>;
    scrollToElement: (selector: string) => Promise<{ success: boolean; error?: string }>;
    clickElement: (selector: string) => Promise<{ success: boolean; tag?: string; text?: string; error?: string }>;
    waitForPageLoadState: (timeout?: number) => Promise<void>;
  },
  params: ClickRequest,
): Promise<ClickResult> {
  let targetSelector: string;
  if (params.selector) {
    targetSelector = params.selector;
  } else if (params.index !== undefined && params.selectorMap) {
    targetSelector = params.selectorMap[params.index];
    if (!targetSelector) {
      throw new Error(
        `Index ${params.index} not found in selectorMap. Available: ${Object.keys(params.selectorMap).join(', ')}`,
      );
    }
  } else {
    throw new Error('Must provide selector or index+selectorMap');
  }

  const preCheck = await page.executeRaw(
    `
    const el = document.querySelector(__vars.selector);
    if (!el) return { exists: false };

    const rect = el.getBoundingClientRect();
    const style = window.getComputedStyle(el);

    return {
      exists: true,
      visible: style.display !== 'none' && style.visibility !== 'hidden',
      rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      tag: el.tagName,
      text: String(el.innerText || '').slice(0, 50),
    };
  `,
    { selector: targetSelector },
  );

  if (!preCheck.exists) {
    return {
      success: false,
      error: `Element does not exist: ${targetSelector}`,
      selectorUsed: targetSelector,
      preCheck,
    };
  }

  if (!preCheck.visible) {
    await page.scrollToElement(targetSelector);
    await new Promise(resolve => setTimeout(resolve, 300));
  }

  const clickResult = await page.clickElement(targetSelector);

  if (params.waitForNavigation) {
    try {
      await page.waitForPageLoadState(params.timeout || 5000);
    } catch (_e) {
      // Non-fatal: click may not trigger navigation.
    }
  }

  return {
    ...clickResult,
    selectorUsed: targetSelector,
    preCheck,
    elementInfo: preCheck.exists
      ? {
          tag: preCheck.tag || '',
          text: preCheck.text || '',
          bounds: preCheck.rect,
        }
      : undefined,
  };
}
