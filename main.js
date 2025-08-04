const { Actor } = require('apify');
const puppeteer = require('puppeteer');
const XLSX = require('xlsx');
const cheerio = require('cheerio');

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
        const module = allModules[i]; // Define module outside try block
        
        try {
          // Check for migration before processing each module
          if (this.checkMigration()) {
            console.log('Migration requested, saving progress...');
            this.currentState.processedModules = i;
            await this.prepareMigration();
            throw new Error('Migration in progress');
          }

          console.log(`Processing module ${i + 1}/${allModules.length}: ${module.title} (ID: ${module.Id})`);
          
          this.currentState.currentModule = module.title;

          // Generate the direct URL for this module
          const moduleUrl = this.generateModuleUrl(module.Id);
          if (!moduleUrl) {
            console.log(`⚠ Could not generate URL for module: ${module.title}`);
            courseStructure.sections[module.sectionIndex].childrenCourses[module.moduleIndex].content = "No URL generated";
            continue;
          }

          // Navigate directly to the module with shorter timeout
          await this.page.goto(moduleUrl, {
            waitUntil: "networkidle2",
            timeout: 30000,
          });

          // Quick content check - if no content found quickly, skip waiting
          const hasContent = await this.quickContentCheck();
          
          if (hasContent) {
            // Give a bit more time for content to fully load
            await this.delay(300);
          } else {
            console.log(`⚠ No content detected for ${module.title}, skipping extended wait`);
          }

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
          
          // Check for migration-related errors (frame detached usually means migration)
          if (error.message.includes('detached') || error.message.includes('session') || this.checkMigration()) {
            console.log('Migration-related error detected, saving progress...');
            this.currentState.processedModules = i;
            await this.prepareMigration();
            throw new Error('Migration in progress');
          }
          
          // Ensure we have valid indices before trying to access courseStructure
          if (courseStructure.sections && 
              courseStructure.sections[module.sectionIndex] && 
              courseStructure.sections[module.sectionIndex].childrenCourses &&
              courseStructure.sections[module.sectionIndex].childrenCourses[module.moduleIndex]) {
            
            // Handle timeout specifically
            if (error.name === 'TimeoutError' || error.message.includes('timeout')) {
              console.log(`⏱ Timeout for module: ${module.title}, marking as no content`);
              courseStructure.sections[module.sectionIndex].childrenCourses[module.moduleIndex].content = "No content found - page timeout";
            } else {
              console.error(`Error processing module ${i + 1} (${module.title}):`, error.message);
              courseStructure.sections[module.sectionIndex].childrenCourses[module.moduleIndex].content = `Error scraping content: ${error.message}`;
            }
          } else {
            console.error(`Error processing module ${i + 1} (${module.title}) - invalid structure indices:`, error.message);
          }
          
          // Update progress even on error to avoid getting stuck
          this.currentState.processedModules = i + 1;
        }
      }

      return courseStructure;
    } catch (error) {
      console.error("Error in direct ID scraping:", error.message);
      throw error;
    }
  }

  // Quick check to see if content is available without full extraction
  async quickContentCheck() {
    try {
      const hasContent = await this.page.evaluate(() => {
        const editorEl = document.querySelector(".tiptap.ProseMirror.skool-editor2");
        
        if (editorEl) {
          const htmlContent = editorEl.innerHTML;
          // Quick check: if there's substantial HTML content, assume it has content
          if (htmlContent && htmlContent.length > 50) {
            // Check if it's not just empty paragraphs and breaks
            const tempDiv = document.createElement('div');
            tempDiv.innerHTML = htmlContent;
            const textContent = tempDiv.textContent || tempDiv.innerText || '';
            const cleanText = textContent.replace(/\s+/g, ' ').trim();
            
            return cleanText.length > 10;
          }
        }
        
        return false;
      });

      return hasContent;
    } catch (error) {
      console.log('Error in quickContentCheck, assuming content exists:', error.message);
      return true;
    }
  }

  // Extract raw HTML and convert to clean text using cheerio
  async extractTextContent() {
    try {
      // Get the raw HTML content from the TipTap editor
      const htmlContent = await this.page.evaluate(() => {
        const editorEl = document.querySelector(".styled__EditorContentWrapper-sc-1cnx5by-2");
        
        if (editorEl) {
          return editorEl.innerHTML;
        }
        
        // Fallback to other content containers
        const contentSelectors = [
          ".styled__EditorContentWrapper-sc-1cnx5by-2",
          ".styled__RichTextEditorWrapper-sc-1cnx5by-0", 
          ".styled__ModuleBody-sc-cgnv0g-3",
          '[data-testid*="content"]',
          ".content",
          "main",
          ".main-content"
        ];

        for (let selector of contentSelectors) {
          const element = document.querySelector(selector);
          if (element) {
            return element.innerHTML;
          }
        }

        return null;
      });

      if (!htmlContent) {
        return "No content found";
      }

      // Use cheerio to parse HTML and extract clean text
      const $ = cheerio.load(htmlContent);
      
      // Remove script and style elements
      $('script, style, svg').remove();
      
      // Remove ProseMirror specific elements that don't contain content
      $('br.ProseMirror-trailingBreak').remove();
      
      // Extract text content with some formatting
      let extractedText = '';
      const textParts = [];
      
      // Extract paragraphs
      $('p').each((i, elem) => {
        const text = $(elem).text().trim();
        if (text && text.length > 0) {
          textParts.push(text);
        }
      });
      
      // If we found paragraphs, use them
      if (textParts.length > 0) {
        extractedText = textParts.join('\n\n');
      } else {
        // Fallback: get all text content
        extractedText = $.text().replace(/\s+/g, ' ').trim();
      }
      
      // Extract images and add their information
      const images = [];
      $('img').each((i, elem) => {
        const $img = $(elem);
        const src = $img.attr('src') || $img.attr('originalsrc');
        const alt = $img.attr('alt') || $img.attr('title') || 'Image';
        
        if (src) {
          images.push(`[Image: ${alt} - ${src}]`);
        }
      });
      
      // Extract links information  
      const links = [];
      $('a').each((i, elem) => {
        const $link = $(elem);
        const href = $link.attr('href');
        const text = $link.text().trim();
        
        if (href && text) {
          links.push(`[Link: ${text} - ${href}]`);
        }
      });
      
      // Combine everything
      let finalContent = extractedText;
      
      if (images.length > 0) {
        finalContent += '\n\n' + images.join('\n');
      }
      
      if (links.length > 0) {
        finalContent += '\n\n' + links.join('\n'); 
      }
      
      return finalContent || "No meaningful content found";
      
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