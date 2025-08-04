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
    this.baseClassroomUrl = null; // Store base URL for constructing module URLs
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

      // Store the base URL for constructing module URLs
      this.baseClassroomUrl = classroomUrl;

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
          const Id = moduleData.id || null;
          
          return {
            title: metadata.title || moduleData.name || "Untitled Module",
            videoLink: metadata.videoLink || null,
            Id: Id,
            content: null // Will be populated during scraping
          };
        });

        return {
          courseTitle: sectionCourse.metadata?.title || sectionCourse.name || "Untitled Course",
          childrenCourses: childrenCourses,
        };
      });

      const result = {
        sections: extractedCourses,
      };

      console.log(`Extracted ${extractedCourses.length} sections`);
      
      // Count total modules
      const totalModules = extractedCourses.reduce((count, section) => 
        count + section.childrenCourses.length, 0
      );
      console.log(`Total modules found: ${totalModules}`);

      return result;
    } catch (error) {
      console.error("Error extracting course structure:", error.message);
      return null;
    }
  }

  // Generate module URL using the base classroom URL and module ID
  generateModuleUrl(moduleId) {
    if (!this.baseClassroomUrl || !moduleId) {
      return null;
    }

    // Extract the base part of the URL (before any query parameters)
    const baseUrl = this.baseClassroomUrl.split('?')[0];
    
    // Construct the module URL with the ID
    return `${baseUrl}?md=${moduleId}`;
  }

  async scrapeDirectWithIds() {
    try {
      console.log("Starting direct scraping using module IDs...");

      // First, get the course structure from __NEXT_DATA__
      const courseStructure = await this.extractCourseStructure();
      if (!courseStructure) {
        console.log("Could not extract course structure");
        throw new Error("Failed to extract course structure");
      }

      // Collect all modules with their IDs
      const allModules = [];
      courseStructure.sections.forEach((section, sectionIndex) => {
        section.childrenCourses.forEach((module, moduleIndex) => {
          if (module.Id) {
            allModules.push({
              ...module,
              sectionIndex,
              moduleIndex,
              sectionTitle: section.courseTitle
            });
          } else {
            console.log(`⚠ Module "${module.title}" has no ID, skipping...`);
          }
        });
      });

      console.log(`Found ${allModules.length} modules with IDs to scrape`);
      this.currentState.totalModules = allModules.length;

      // Process each module directly using its ID
      for (let i = this.currentState.processedModules; i < allModules.length; i++) {
        try {
          // Check for migration before processing each module
          if (this.checkMigration()) {
            console.log('Migration requested, saving progress...');
            this.currentState.processedModules = i;
            await this.prepareMigration();
            throw new Error('Migration in progress');
          }

          const module = allModules[i];
          console.log(`Processing module ${i + 1}/${allModules.length}: ${module.title} (ID: ${module.Id})`);
          
          this.currentState.currentModule = module.title;

          // Generate the direct URL for this module
          const moduleUrl = this.generateModuleUrl(module.Id);
          if (!moduleUrl) {
            console.log(`⚠ Could not generate URL for module: ${module.title}`);
            continue;
          }

          // Navigate directly to the module
          await this.page.goto(moduleUrl, {
            waitUntil: "networkidle2",
            timeout: 8000,
          });

          await this.delay(300);

          // Extract content from this module
          const scrapedContent = await this.extractTextContent();

          // Add the content directly to the course structure
          courseStructure.sections[module.sectionIndex].childrenCourses[module.moduleIndex].content = scrapedContent;

          console.log(`✅ Scraped content for: ${module.title} (${scrapedContent.length} characters)`);
          
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
          
          // Still add error info to the structure
          const module = allModules[i];
          courseStructure.sections[module.sectionIndex].childrenCourses[module.moduleIndex].content = `Error scraping content: ${error.message}`;
        }
      }

      return courseStructure;
    } catch (error) {
      console.error("Error in direct ID scraping:", error.message);
      throw error;
    }
  }

  // Simplified text extraction method
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

    // Use the new direct ID-based scraping method
    console.log("Using direct ID-based scraping method...");
    const courseStructure = await scraper.scrapeDirectWithIds();
    
    // Flatten the data for output
    const flattenedData = [];
    courseStructure.sections.forEach((section) => {
      section.childrenCourses.forEach((module) => {
        flattenedData.push({
          courseTitle: section.courseTitle,
          moduleTitle: module.title,
          moduleId: module.Id,
          videoLink: module.videoLink || "",
          content: module.content || "No content scraped",
          scrapedAt: new Date().toISOString(),
        });
      });
    });

    const result = {
      type: 'direct_id_scraping',
      totalSections: courseStructure.sections.length,
      totalModules: flattenedData.length,
      data: flattenedData,
      rawStructure: courseStructure
    };

    // Mark as completed
    scraper.currentState.step = 'completed';
    await scraper.saveState();

    // Save results to dataset
    await Actor.pushData(result);

    // Also save individual items for easier processing
    for (const item of result.data) {
      await Actor.pushData(item);
    }

    // Log summary
    console.log('=== SCRAPING COMPLETED ===');
    console.log(`Scraping method: ${result.type}`);
    console.log(`Total sections: ${result.totalSections}`);
    console.log(`Total modules: ${result.totalModules}`);
    
    // Count modules with content
    const modulesWithContent = result.data.filter(item => 
      item.content && 
      item.content !== "No content scraped" && 
      !item.content.startsWith("Error scraping content")
    ).length;
    console.log(`Modules with scraped content: ${modulesWithContent}`);
    
    const modulesWithErrors = result.data.filter(item => 
      item.content && item.content.startsWith("Error scraping content")
    ).length;
    console.log(`Modules with errors: ${modulesWithErrors}`);

  } catch (error) {
    if (error.message === 'Migration in progress') {
      console.log('Actor is migrating. The scraping will resume on the new server.');
      // Exit gracefully
      return;
    }
    console.error('Scraping failed:', error.message);
    throw error;
  } finally {
    await scraper.close();
  }
});