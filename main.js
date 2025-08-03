const { Actor } = require('apify');
const puppeteer = require('puppeteer');
const XLSX = require('xlsx');

class SkoolScraper {
  constructor() {
    this.browser = null;
    this.page = null;
    this.data = [];
    this.shouldMigrate = false;
    this.currentState = {
      step: 'initializing',
      processedModules: 0,
      totalModules: 0,
      currentModule: null,
      scrapedData: []
    };
  }

  delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  // Save current progress state
  async saveState() {
    try {
      await Actor.setValue('SCRAPER_STATE', {
        ...this.currentState,
        scrapedData: this.data,
        timestamp: Date.now()
      });
      console.log('State saved successfully');
    } catch (error) {
      console.error('Failed to save state:', error.message);
    }
  }

  // Load previous progress state
  async loadState() {
    try {
      const savedState = await Actor.getValue('SCRAPER_STATE');
      if (savedState && savedState.timestamp) {
        // Only restore if saved within last hour (3600000ms)
        const hourAgo = Date.now() - 3600000;
        if (savedState.timestamp > hourAgo) {
          this.currentState = { ...this.currentState, ...savedState };
          this.data = savedState.scrapedData || [];
          console.log(`Restored state: ${this.currentState.step}, processed ${this.currentState.processedModules} modules`);
          return true;
        }
      }
      return false;
    } catch (error) {
      console.error('Failed to load state:', error.message);
      return false;
    }
  }

  // Check if migration is needed
  checkMigration() {
    return this.shouldMigrate;
  }

  // Handle migration preparation
  async prepareMigration() {
    console.log('Preparing for migration...');
    this.shouldMigrate = true;
    
    // Save current progress
    await this.saveState();
    
    // Close browser gracefully
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
    }
    
    console.log('Migration preparation completed');
  }

  async init() {
    // Check if we're resuming from a migration
    const resumed = await this.loadState();
    if (resumed && this.currentState.step === 'completed') {
      console.log('Scraping already completed, skipping...');
      return;
    }

    this.browser = await puppeteer.launch({
      headless: true,
      defaultViewport: null,
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
    });
    this.page = await this.browser.newPage();

    // Set user agent to avoid detection
    await this.page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36"
    );

    // Set viewport
    await this.page.setViewport({ width: 1366, height: 768 });
    
    if (!resumed) {
      this.currentState.step = 'initialized';
    }
  }

  async login(email, password) {
    try {
      // Skip if already logged in after migration
      if (this.currentState.step === 'logged_in' || 
          this.currentState.step === 'scraping' || 
          this.currentState.step === 'completed') {
        console.log('Skipping login - already authenticated');
        return;
      }

      console.log("Navigating to login page...");
      await this.page.goto("https://www.skool.com/login", {
        waitUntil: "networkidle2",
        timeout: 30000,
      });

      // Check for migration during navigation
      if (this.checkMigration()) {
        await this.prepareMigration();
        throw new Error('Migration in progress');
      }

      // Wait for login form
      await this.page.waitForSelector('input[type="email"]', {
        timeout: 10000,
      });

      // Fill login credentials
      await this.page.type('input[type="email"]', email);
      await this.page.type('input[type="password"]', password);

      // Click login button
      await this.page.click('button[type="submit"]');

      // Wait for navigation after login
      await this.page.waitForNavigation({ waitUntil: "networkidle2" });

      console.log("Login successful!");
      this.currentState.step = 'logged_in';
      await this.saveState();

      // Wait a bit for any redirects
      await this.delay(500);
    } catch (error) {
      console.error("Login failed:", error.message);
      throw error;
    }
  }

  async navigateToClassroom(classroomUrl) {
    try {
      console.log("Navigating to classroom...");
      await this.page.goto(classroomUrl, {
        waitUntil: "networkidle2",
        timeout: 30000,
      });

      // Wait for classroom content to load
      await this.delay(300);
    } catch (error) {
      console.error("Navigation to classroom failed:", error.message);
      throw error;
    }
  }

  async extractCourseStructure() {
    try {
      console.log("Extracting course structure from __NEXT_DATA__...");

      const nextData = await this.page.evaluate(() => {
        const scriptTag = document.getElementById("__NEXT_DATA__");
        return scriptTag ? scriptTag.textContent : null;
      });

      if (!nextData) {
        console.log("No __NEXT_DATA__ found");
        return null;
      }

      const parsedData = JSON.parse(nextData);
      const courseData = parsedData.props?.pageProps?.course;

      if (!courseData) {
        console.log("No course data found in __NEXT_DATA__");
        return null;
      }

      // Extract the main course information
      const mainCourse = courseData.course;
      const children = courseData.children || [];

      // Process each top-level section (sets)
      const extractedCourses = children.map((section) => {
        const sectionCourse = section.course;
        const sectionChildren = section.children || [];

        // Extract modules from this section
        const childrenCourses = sectionChildren.map((module) => {
          const moduleData = module.course;
          const metadata = moduleData.metadata || {};

          return {
            title: metadata.title || moduleData.name || "Untitled Module",
            videoLink: metadata.videoLink || null,
          };
        });

        return {
          courseTitle:
            sectionCourse.metadata?.title ||
            sectionCourse.name ||
            "Untitled Course",
          childrenCourses: childrenCourses,
        };
      });

      const result = {
        sections: extractedCourses,
      };

      console.log(`Extracted ${extractedCourses.length} sections`);

      return result;
    } catch (error) {
      console.error("Error extracting course structure:", error.message);
      return null;
    }
  }

  async scrapeAndMatchContent() {
    try {
      console.log("Starting enhanced scraping with course structure matching...");

      // First, get the course structure from __NEXT_DATA__
      const courseStructure = await this.extractCourseStructure();
      if (!courseStructure) {
        console.log("Could not extract course structure, falling back to regular scraping");
        return await this.scrapeClassroomTabs();
      }

      console.log(`Found ${courseStructure.sections.length} sections in course structure`);

      // Wait for the page to load completely
    //   await this.delay(1000);

      // Check SVG arrow direction and only expand collapsed sections
      console.log("Checking section states by SVG arrow direction...");

      const sectionStates = await this.page.evaluate(() => {
        const headers = Array.from(document.querySelectorAll('[data-rbd-draggable-id^="set-"]'));
        return headers.map((header, index) => {
          const title = header.querySelector('[title]')?.getAttribute('title') || 
                        header.textContent.trim();
          
          const svgIcon = header.querySelector('svg');
          let isCollapsed = false;
          let rotationAngle = 0;
          let transform = 'none';
          
          if (svgIcon) {
            const iconWrapper = header.querySelector('.styled__IconWrapper-sc-zxv7pb-0');
            if (iconWrapper) {
              const computedStyle = window.getComputedStyle(iconWrapper);
              transform = computedStyle.transform || 'none';
              
              // Parse transform matrix to get rotation angle
              if (transform && transform !== 'none') {
                if (transform.includes('matrix')) {
                  const matrixMatch = transform.match(/matrix\(([^)]+)\)/);
                  if (matrixMatch) {
                    const values = matrixMatch[1].split(',').map(v => parseFloat(v.trim()));
                    if (values.length >= 4) {
                      rotationAngle = Math.round(Math.atan2(values[1], values[0]) * (180 / Math.PI));
                    }
                  }
                } else if (transform.includes('rotate')) {
                  const rotateMatch = transform.match(/rotate\(([^)]+)\)/);
                  if (rotateMatch) {
                    rotationAngle = parseFloat(rotateMatch[1]);
                  }
                }
              }
              
              // 0° = collapsed (pointing right), 90° = expanded (pointing down)
              const absAngle = Math.abs(rotationAngle);
              if (absAngle < 10 || absAngle > 350) {
                isCollapsed = true; // Close to 0° = collapsed
              } else if (absAngle > 80 && absAngle < 100) {
                isCollapsed = false; // Close to 90° = expanded
              } else {
                isCollapsed = transform === 'none' || transform === 'matrix(1, 0, 0, 1, 0, 0)';
              }
            }
          }
          
          return {
            index,
            title,
            hasSvg: !!svgIcon,
            isCollapsed,
            rotationAngle,
            needsExpansion: svgIcon && isCollapsed
          };
        });
      });

      // Only expand sections where arrow is pointing right (collapsed)
      const sectionsToExpand = sectionStates.filter(section => section.needsExpansion);
      console.log(`Expanding ${sectionsToExpand.length} collapsed sections...`);

      for (let i = 0; i < sectionsToExpand.length; i++) {
        const section = sectionsToExpand[i];
        try {
          console.log(`▶ Expanding: ${section.title}`);
          
          await this.page.evaluate((sectionIndex) => {
            const headers = Array.from(document.querySelectorAll('[data-rbd-draggable-id^="set-"]'));
            const sectionHeader = headers[sectionIndex];
            if (sectionHeader) {
              const dropdownIcon = sectionHeader.querySelector('.styled__IconWrapper-sc-zxv7pb-0');
              if (dropdownIcon) {
                dropdownIcon.click();
              } else {
                const titleWrapper = sectionHeader.querySelector('.styled__MenuItemTitleWrapper-sc-1wvgzj7-6');
                if (titleWrapper) {
                  titleWrapper.click();
                }
              }
            }
          }, section.index);

          await this.delay(500);
          
        } catch (error) {
          console.log(`✗ Failed to expand ${section.title}:`, error.message);
        }
      }

      // Final wait for all animations to complete
    //   await this.delay(500);

      // Now find all module links after expansion
      const moduleLinks = await this.page.evaluate(() => {
        const links = Array.from(document.querySelectorAll('a[href*="/classroom/"]'));
        return links.map((el) => ({
          text: el.querySelector("[title]")?.getAttribute("title") || 
                el.textContent.trim(),
          href: el.href,
          moduleId: el.href.split("md=")[1] || "unknown",
        }));
      });

      // Remove duplicates
      const uniqueModuleLinks = moduleLinks.filter((link, index, self) => 
        index === self.findIndex(l => l.href === link.href)
      );

      console.log(`Found ${uniqueModuleLinks.length} unique modules to scrape`);

      // Navigate through each module and scrape content
      for (let i = this.currentState.processedModules; i < uniqueModuleLinks.length; i++) {
        try {
          // Check for migration before processing each module
          if (this.checkMigration()) {
            console.log('Migration requested, saving progress...');
            this.currentState.processedModules = i;
            await this.prepareMigration();
            throw new Error('Migration in progress');
          }

          const module = uniqueModuleLinks[i];
          console.log(`Processing module ${i + 1}/${uniqueModuleLinks.length}: ${module.text}`);
          
          this.currentState.currentModule = module.text;
          this.currentState.totalModules = uniqueModuleLinks.length;

          // Navigate to the module
          await this.page.goto(module.href, {
            waitUntil: "networkidle2",
            timeout: 30000,
          });

          await this.delay(300);

          // Scrape content from this module
          const scrapedContent = await this.extractTextContent();

          // Find matching module in course structure and add content
          this.matchAndAddContent(courseStructure, module.text, scrapedContent);
          
          // Update progress
          this.currentState.processedModules = i + 1;
          
          // Save state every 3 modules
          if ((i + 1) % 3 === 0) {
            await this.saveState();
          }
          
        } catch (error) {
          if (error.message === 'Migration in progress') {
            throw error; // Re-throw migration errors
          }
          console.error(`Error processing module ${i + 1}:`, error.message);
          // Continue with next module for other errors
        }
      }

      return courseStructure;
    } catch (error) {
      console.error("Error in enhanced scraping:", error.message);
      throw error;
    }
  }

  async scrapeClassroomTabs() {
    try {
      console.log("Starting to scrape classroom modules...");

      // Wait for the page to load completely
      await this.delay(1500);

      // Check SVG arrow direction and only expand collapsed sections
      console.log("Checking section states by SVG arrow direction...");

      const sectionStates = await this.page.evaluate(() => {
        const headers = Array.from(document.querySelectorAll('[data-rbd-draggable-id^="set-"]'));
        return headers.map((header, index) => {
          const title = header.querySelector('[title]')?.getAttribute('title') || 
                        header.textContent.trim();
          
          const svgIcon = header.querySelector('svg');
          let isCollapsed = false;
          let rotationAngle = 0;
          let transform = 'none';
          
          if (svgIcon) {
            const iconWrapper = header.querySelector('.styled__IconWrapper-sc-zxv7pb-0');
            if (iconWrapper) {
              const computedStyle = window.getComputedStyle(iconWrapper);
              transform = computedStyle.transform || 'none';
              
              // Parse transform matrix to get rotation angle
              if (transform && transform !== 'none') {
                if (transform.includes('matrix')) {
                  const matrixMatch = transform.match(/matrix\(([^)]+)\)/);
                  if (matrixMatch) {
                    const values = matrixMatch[1].split(',').map(v => parseFloat(v.trim()));
                    if (values.length >= 4) {
                      rotationAngle = Math.round(Math.atan2(values[1], values[0]) * (180 / Math.PI));
                    }
                  }
                } else if (transform.includes('rotate')) {
                  const rotateMatch = transform.match(/rotate\(([^)]+)\)/);
                  if (rotateMatch) {
                    rotationAngle = parseFloat(rotateMatch[1]);
                  }
                }
              }
              
              // 0° = collapsed (pointing right), 90° = expanded (pointing down)
              const absAngle = Math.abs(rotationAngle);
              if (absAngle < 10 || absAngle > 350) {
                isCollapsed = true; // Close to 0° = collapsed
              } else if (absAngle > 80 && absAngle < 100) {
                isCollapsed = false; // Close to 90° = expanded
              } else {
                isCollapsed = transform === 'none' || transform === 'matrix(1, 0, 0, 1, 0, 0)';
              }
            }
          }
          
          return {
            index,
            title,
            hasSvg: !!svgIcon,
            isCollapsed,
            rotationAngle,
            needsExpansion: svgIcon && isCollapsed
          };
        });
      });

      console.log(`Found ${sectionStates.length} sections:`);
      sectionStates.forEach((section, i) => {
        if (section.hasSvg) {
          const status = section.isCollapsed ? 
            `COLLAPSED (${section.rotationAngle}° - will expand)` : 
            `EXPANDED (${section.rotationAngle}° - will skip)`;
          console.log(`  ${i + 1}. ${section.title} - ${status}`);
        } else {
          console.log(`  ${i + 1}. ${section.title} - No dropdown arrow`);
        }
      });

      // Only expand sections where arrow is pointing right (collapsed)
      const sectionsToExpand = sectionStates.filter(section => section.needsExpansion);
      console.log(`\nExpanding ${sectionsToExpand.length} collapsed sections...`);

      for (let i = 0; i < sectionsToExpand.length; i++) {
        const section = sectionsToExpand[i];
        try {
          console.log(`▶ Expanding: ${section.title} (was at ${section.rotationAngle}°)`);
          
          await this.page.evaluate((sectionIndex) => {
            const headers = Array.from(document.querySelectorAll('[data-rbd-draggable-id^="set-"]'));
            const sectionHeader = headers[sectionIndex];
            if (sectionHeader) {
              const dropdownIcon = sectionHeader.querySelector('.styled__IconWrapper-sc-zxv7pb-0');
              if (dropdownIcon) {
                dropdownIcon.click();
              } else {
                const titleWrapper = sectionHeader.querySelector('.styled__MenuItemTitleWrapper-sc-1wvgzj7-6');
                if (titleWrapper) {
                  titleWrapper.click();
                }
              }
            }
          }, section.index);

          await this.delay(500);
          
        } catch (error) {
          console.log(`✗ Failed to expand ${section.title}:`, error.message);
        }
      }

      // Final wait for all animations to complete
    //   await this.delay(500);

      // Now find all module links from all expanded sections
      const moduleLinks = await this.page.evaluate(() => {
        const links = Array.from(document.querySelectorAll('a[href*="/classroom/"]'));
        return links.map((el) => ({
          text: el.querySelector("[title]")?.getAttribute("title") || 
                el.textContent.trim(),
          href: el.href,
          moduleId: el.href.split("md=")[1] || "unknown",
        }));
      });

      // Remove duplicates based on href
      const uniqueModuleLinks = moduleLinks.filter((link, index, self) => 
        index === self.findIndex(l => l.href === link.href)
      );

      console.log(`\n✅ Found ${uniqueModuleLinks.length} total modules after smart expansion`);

      // Also get the current page content first
      const currentContent = await this.scrapeCurrentPageContent();
      if (currentContent) {
        this.data.push(currentContent);
      }

      // Navigate through each unique module
      for (let i = this.currentState.processedModules; i < uniqueModuleLinks.length; i++) {
        try {
          // Check for migration before processing each module
          if (this.checkMigration()) {
            console.log('Migration requested, saving progress...');
            this.currentState.processedModules = i;
            await this.prepareMigration();
            throw new Error('Migration in progress');
          }

          const module = uniqueModuleLinks[i];
          console.log(`Processing module ${i + 1}/${uniqueModuleLinks.length}: ${module.text}`);
          
          this.currentState.currentModule = module.text;
          this.currentState.totalModules = uniqueModuleLinks.length;

          // Navigate to the module
          await this.page.goto(module.href, {
            waitUntil: "networkidle2",
            timeout: 30000,
          });

          await this.delay(500);

          // Scrape content from this module
          const moduleContent = await this.scrapeTabContent(module.text);
          this.data.push(moduleContent);
          
          // Update progress
          this.currentState.processedModules = i + 1;
          
          // Save state every 3 modules
          if ((i + 1) % 3 === 0) {
            await this.saveState();
          }
          
        } catch (error) {
          if (error.message === 'Migration in progress') {
            throw error; // Re-throw migration errors
          }
          console.error(`Error processing module ${i + 1}:`, error.message);
          // Continue with next module for other errors
        }
      }
    } catch (error) {
      console.error("Error scraping modules:", error.message);
      throw error;
    }
  }

  async scrapeCurrentPageContent() {
    try {
      const content = {
        tabTitle: "Current Page",
        videoTitle: "",
        videoUrl: "",
        videoDuration: "",
        textContent: "",
        scrapedAt: new Date().toISOString(),
      };

      // Get the current module title
      try {
        const moduleTitle = await this.page.evaluate(() => {
          const titleEl = document.querySelector(
            ".styled__ModuleTitle-sc-cgnv0g-1, [title]"
          );
          return titleEl
            ? titleEl.getAttribute("title") || titleEl.textContent.trim()
            : "Current Page";
        });
        content.tabTitle = moduleTitle || "Current Page";
      } catch (e) {
        console.log("Could not find module title");
      }

      // Try to find video information
      await this.extractVideoInfo(content);

      // Try to scrape text content
      await this.extractTextContentForModule(content);

      return content;
    } catch (error) {
      console.error("Error scraping current page:", error.message);
      return null;
    }
  }

  async extractVideoInfo(content) {
    try {
      // Look for video elements
      const videoInfo = await this.page.evaluate(() => {
        // Look for various video selectors
        const videoSelectors = [
          'video',
          'iframe[src*="youtube"]',
          'iframe[src*="vimeo"]',
          '[data-testid*="video"]',
          '.video-player',
          '.video-container'
        ];

        for (let selector of videoSelectors) {
          const videoEl = document.querySelector(selector);
          if (videoEl) {
            return {
              videoUrl: videoEl.src || videoEl.currentSrc || '',
              videoDuration: videoEl.duration || '',
              videoTitle: videoEl.title || videoEl.getAttribute('title') || ''
            };
          }
        }

        return null;
      });

      if (videoInfo) {
        content.videoUrl = videoInfo.videoUrl;
        content.videoDuration = videoInfo.videoDuration;
        content.videoTitle = videoInfo.videoTitle;
      }
    } catch (error) {
      console.log("Error extracting video info:", error.message);
    }
  }

  async extractTextContentForModule(content) {
    // Enhanced content extraction for TipTap ProseMirror editor
    try {
      // Look for the rich text editor content first
      let extractedContent = await this.page.evaluate(() => {
        const editorEl = document.querySelector(
          ".tiptap.ProseMirror.skool-editor2"
        );

        function extractContentFromElement(element) {
          const result = {
            paragraphs: [],
            images: [],
            links: [],
            textContent: "",
          };

          if (!element) return result;

          // Extract all paragraphs (including nested ones)
          const paragraphs = Array.from(element.querySelectorAll("p"));
          result.paragraphs = paragraphs
            .map((p) => p.innerText.trim())
            .filter((text) => text.length > 0);

          // Extract all images (including nested ones)
          const images = Array.from(element.querySelectorAll("img"));
          result.images = images.map((img) => ({
            src: img.src,
            alt: img.alt || "",
            title: img.title || "",
            width: img.width || img.naturalWidth || null,
            height: img.height || img.naturalHeight || null,
          }));

          // Extract all links (including nested ones)
          const links = Array.from(element.querySelectorAll("a"));
          result.links = links
            .map((link) => ({
              href: link.href,
              text: link.innerText.trim(),
              title: link.title || "",
              target: link.target || "",
            }))
            .filter((link) => link.href && link.href !== "#");

          // Get clean text content
          const clone = element.cloneNode(true);
          const scriptsAndStyles = clone.querySelectorAll("script, style, svg");
          scriptsAndStyles.forEach((el) => el.remove());
          result.textContent = clone.innerText.trim();

          return result;
        }

        if (editorEl) {
          return extractContentFromElement(editorEl);
        }

        return null;
      });

      // If no editor content found, try fallback selectors
      if (!extractedContent) {
        extractedContent = await this.page.evaluate(() => {
          const contentSelectors = [
            ".styled__EditorContentWrapper-sc-1cnx5by-2",
            ".styled__RichTextEditorWrapper-sc-1cnx5by-0",
            ".styled__ModuleBody-sc-cgnv0g-3",
            '[data-testid*="content"]',
            ".content",
            "main",
            ".main-content",
          ];

          function extractContentFromElement(element) {
            const result = {
              paragraphs: [],
              images: [],
              links: [],
              textContent: "",
            };

            if (!element) return result;

            // Extract all paragraphs (including nested ones)
            const paragraphs = Array.from(element.querySelectorAll("p"));
            result.paragraphs = paragraphs
              .map((p) => p.innerText.trim())
              .filter((text) => text.length > 0);

            // Extract all images (including nested ones)
            const images = Array.from(element.querySelectorAll("img"));
            result.images = images.map((img) => ({
              src: img.src,
              alt: img.alt || "",
              title: img.title || "",
              width: img.width || img.naturalWidth || null,
              height: img.height || img.naturalHeight || null,
            }));

            // Extract all links (including nested ones)
            const links = Array.from(element.querySelectorAll("a"));
            result.links = links
              .map((link) => ({
                href: link.href,
                text: link.innerText.trim(),
                title: link.title || "",
                target: link.target || "",
              }))
              .filter((link) => link.href && link.href !== "#");

            // Get clean text content
            const clone = element.cloneNode(true);
            const scriptsAndStyles =
              clone.querySelectorAll("script, style, svg");
            scriptsAndStyles.forEach((el) => el.remove());
            result.textContent = clone.innerText.trim();

            return result;
          }

          for (let selector of contentSelectors) {
            const element = document.querySelector(selector);
            if (element) {
              const content = extractContentFromElement(element);
              if (content.textContent && content.textContent.length > 10) {
                return content;
              }
            }
          }

          return {
            paragraphs: [],
            images: [],
            links: [],
            textContent: "",
          };
        });
      }

      // Structure the final content object
      content.textContent =
        extractedContent?.textContent || "No text content found";
      content.paragraphs = extractedContent?.paragraphs || [];
      content.images = extractedContent?.images || [];
      content.links = extractedContent?.links || [];

      // Optional: Create formatted text from paragraphs
      if (content.paragraphs.length > 0) {
        content.formattedText = content.paragraphs.join("\n\n");
      }

      console.log("Extracted content:", {
        paragraphCount: content.paragraphs.length,
        imageCount: content.images.length,
        linkCount: content.links.length,
        textLength: content.textContent.length,
      });
    } catch (error) {
      console.log("Error extracting content:", error.message);
      content.textContent = "Error extracting content";
      content.paragraphs = [];
      content.images = [];
      content.links = [];
    }
  }

  async scrapeTabContent(moduleTitle) {
    try {
      const content = {
        tabTitle: moduleTitle,
        videoTitle: "",
        videoUrl: "",
        videoDuration: "",
        textContent: "",
        scrapedAt: new Date().toISOString(),
      };

      // Wait for content to load
      await this.delay(400);

      // Extract video and text content
      await this.extractVideoInfo(content);
      await this.extractTextContentForModule(content);

      return content;
    } catch (error) {
      console.error("Error scraping module content:", error.message);
      return {
        tabTitle: moduleTitle,
        videoTitle: "Error",
        videoUrl: "Error",
        videoDuration: "Error",
        textContent: "Error extracting content",
        scrapedAt: new Date().toISOString(),
      };
    }
  }

  // Helper method to extract just text content (simplified version)
  async extractTextContent() {
    try {
      // Look for the rich text editor content first
      let extractedContent = await this.page.evaluate(() => {
        const editorEl = document.querySelector(
          ".tiptap.ProseMirror.skool-editor2"
        );

        function extractContentFromElement(element) {
          if (!element) return null;

          // Get clean text content
          const clone = element.cloneNode(true);
          const scriptsAndStyles = clone.querySelectorAll("script, style, svg");
          scriptsAndStyles.forEach((el) => el.remove());

          return clone.innerText.trim();
        }

        if (editorEl) {
          return extractContentFromElement(editorEl);
        }

        return null;
      });

      // If no editor content found, try fallback selectors
      if (!extractedContent) {
        extractedContent = await this.page.evaluate(() => {
          const contentSelectors = [
            ".styled__EditorContentWrapper-sc-1cnx5by-2",
            ".styled__RichTextEditorWrapper-sc-1cnx5by-0",
            ".styled__ModuleBody-sc-cgnv0g-3",
            '[data-testid*="content"]',
            ".content",
            "main",
            ".main-content",
          ];

          for (let selector of contentSelectors) {
            const element = document.querySelector(selector);
            if (element) {
              const clone = element.cloneNode(true);
              const scriptsAndStyles =
                clone.querySelectorAll("script, style, svg");
              scriptsAndStyles.forEach((el) => el.remove());
              const textContent = clone.innerText.trim();

              if (textContent && textContent.length > 10) {
                return textContent;
              }
            }
          }

          return null;
        });
      }

      return extractedContent || "No content found";
    } catch (error) {
      console.log("Error extracting content:", error.message);
      return "Error extracting content";
    }
  }

  // Helper method to match scraped content with course structure
  matchAndAddContent(courseStructure, moduleTitle, scrapedContent) {
    try {
      // Search through all sections and their children
      for (let section of courseStructure.sections) {
        for (let child of section.childrenCourses) {
          // Try exact match first
          if (child.title === moduleTitle) {
            child.content = scrapedContent;
            console.log(`✓ Matched content for: ${moduleTitle}`);
            return;
          }

          // Try partial match (in case titles are slightly different)
          if (
            child.title.includes(moduleTitle) ||
            moduleTitle.includes(child.title)
          ) {
            child.content = scrapedContent;
            console.log(
              `✓ Partial match for: ${moduleTitle} -> ${child.title}`
            );
            return;
          }
        }
      }

      console.log(`⚠ No match found for: ${moduleTitle}`);
    } catch (error) {
      console.error("Error matching content:", error.message);
    }
  }

  async close() {
    if (this.browser) {
      await this.browser.close();
    }
  }
}

Actor.main(async () => {
  const input = await Actor.getInput();
  
  // Validate input
  if (!input.email || !input.password || !input.classroomUrl) {
    throw new Error('Missing required input parameters: email, password, and classroomUrl');
  }

  const scraper = new SkoolScraper();

  // Set up migration handler
  Actor.on('migrating', async () => {
    console.log('Received migration event');
    await scraper.prepareMigration();
  });

  // Set up periodic state saving
  const saveInterval = setInterval(async () => {
    await scraper.saveState();
  }, 15000); // Save every 15 seconds

  try {
    await scraper.init();

    // Skip if already completed
    if (scraper.currentState.step === 'completed') {
      console.log('Scraping already completed');
      return;
    }

    // Login with provided credentials (skip if already logged in)
    await scraper.login(input.email, input.password);

    // Navigate to the specific classroom (skip if already navigated)
    if (scraper.currentState.step !== 'scraping') {
      await scraper.navigateToClassroom(input.classroomUrl);
      scraper.currentState.step = 'scraping';
      await scraper.saveState();
    }

    // Choose scraping method based on input
    let result;
    if (input.useEnhancedScraping !== false) { // Default to enhanced scraping
      console.log("Using enhanced scraping method...");
      const enhancedCourseStructure = await scraper.scrapeAndMatchContent();
      
      if (enhancedCourseStructure) {
        // Flatten the data for output
        const flattenedData = [];
        enhancedCourseStructure.sections.forEach((section) => {
          section.childrenCourses.forEach((module) => {
            flattenedData.push({
              courseTitle: section.courseTitle,
              moduleTitle: module.title,
              videoLink: module.videoLink || "",
              content: module.content || "No content scraped",
              scrapedAt: new Date().toISOString(),
            });
          });
        });

        result = {
          type: 'enhanced',
          totalSections: enhancedCourseStructure.sections.length,
          totalModules: flattenedData.length,
          data: flattenedData,
          rawStructure: enhancedCourseStructure
        };
      } else {
        console.log("Enhanced scraping failed, falling back to regular scraping...");
        await scraper.scrapeClassroomTabs();
        result = {
          type: 'regular',
          totalModules: scraper.data.length,
          data: scraper.data
        };
      }
    } else {
      console.log("Using regular scraping method...");
      await scraper.scrapeClassroomTabs();
      result = {
        type: 'regular',
        totalModules: scraper.data.length,
        data: scraper.data
      };
    }

    // Mark as completed
    scraper.currentState.step = 'completed';
    await scraper.saveState();

    // Save results to dataset
    await Actor.pushData(result);

    // Also save individual items for easier processing
    if (result.data && Array.isArray(result.data)) {
      for (const item of result.data) {
        await Actor.pushData(item);
      }
    }

    // Log summary
    console.log('=== SCRAPING COMPLETED ===');
    console.log(`Scraping method: ${result.type}`);
    console.log(`Total items scraped: ${result.data ? result.data.length : 0}`);
    
    if (result.type === 'enhanced') {
      console.log(`Total sections: ${result.totalSections}`);
      console.log(`Total modules: ${result.totalModules}`);
      
      // Count modules with content
      const modulesWithContent = result.data.filter(item => 
        item.content && item.content !== "No content scraped"
      ).length;
      console.log(`Modules with scraped content: ${modulesWithContent}`);
    }

  } catch (error) {
    if (error.message === 'Migration in progress') {
      console.log('Actor is migrating. The scraping will resume on the new server.');
      // Exit gracefully
      return;
    }
    console.error('Scraping failed:', error.message);
    throw error;
  } finally {
    clearInterval(saveInterval);
    await scraper.close();
  }
});