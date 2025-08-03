# Skool.com Classroom Scraper

This Apify actor scrapes content from Skool.com classrooms, extracting course modules, text content, video links, and course structure.

## Features

- **Enhanced Scraping**: Extracts complete course structure from page data
- **Regular Scraping**: Falls back to DOM-based scraping if enhanced method fails
- **Smart Section Expansion**: Automatically expands collapsed course sections
- **Content Extraction**: Scrapes text content, video links, images, and metadata
- **Duplicate Handling**: Removes duplicate modules automatically
- **Error Recovery**: Continues scraping even if individual modules fail

## Input Parameters

### Required
- **Email**: Your Skool.com account email
- **Password**: Your Skool.com account password  
- **Classroom URL**: Full URL of the classroom to scrape

### Optional
- **Use Enhanced Scraping**: Enable enhanced scraping method (default: true)
- **Max Concurrency**: Maximum concurrent requests (1-10, default: 1)
- **Delay Between Requests**: Delay in milliseconds between requests (default: 2000ms)

## Output

The actor outputs scraped data in the following format:

### Enhanced Scraping Output
```json
{
  "type": "enhanced",
  "totalSections": 5,
  "totalModules": 25,
  "data": [
    {
      "courseTitle": "Introduction to Marketing",
      "moduleTitle": "Getting Started",
      "videoLink": "https://example.com/video",
      "content": "Module text content...",
      "scrapedAt": "2024-01-01T12:00:00.000Z"
    }
  ],
  "rawStructure": { /* Complete course structure */ }
}
```

### Regular Scraping Output
```json
{
  "type": "regular", 
  "totalModules": 25,
  "data": [
    {
      "tabTitle": "Module 1: Getting Started",
      "videoTitle": "Introduction Video",
      "videoUrl": "https://example.com/video",
      "videoDuration": "15:30",
      "textContent": "Module content...",
      "paragraphs": ["Paragraph 1", "Paragraph 2"],
      "images": [{"src": "image.jpg", "alt": "Description"}],
      "links": [{"href": "link.com", "text": "Link Text"}],
      "scrapedAt": "2024-01-01T12:00:00.000Z"
    }
  ]
}
```

## How It Works

1. **Authentication**: Logs into Skool.com using provided credentials
2. **Navigation**: Navigates to the specified classroom URL
3. **Section Analysis**: Analyzes dropdown arrows to identify collapsed sections
4. **Smart Expansion**: Expands only collapsed sections (avoids unnecessary clicks)
5. **Module Discovery**: Finds all module links after expansion
6. **Content Scraping**: Visits each module and extracts content
7. **Data Processing**: Structures and deduplicates the scraped data

## Scraping Methods

### Enhanced Scraping (Recommended)
- Extracts course structure from page's `__NEXT_DATA__` 
- Matches scraped content with structured course data
- Provides better organization and metadata
- More reliable for complex course structures

### Regular Scraping (Fallback)
- DOM-based scraping approach
- Extracts content directly from page elements
- Used when enhanced method fails
- Still provides comprehensive content extraction

## Best Practices

1. **Rate Limiting**: Use appropriate delays to avoid being blocked
2. **Single Concurrency**: Keep max concurrency at 1 for stability
3. **Valid Credentials**: Ensure your Skool.com account has access to the classroom
4. **Full URLs**: Use complete classroom URLs including all parameters

## Troubleshooting

### Common Issues
- **Login Failed**: Check email/password and account status
- **No Content Found**: Verify classroom URL and access permissions
- **Timeout Errors**: Increase timeout settings or reduce concurrency

### Error Handling
The actor includes comprehensive error handling:
- Continues scraping if individual modules fail
- Falls back to regular scraping if enhanced method fails
- Logs detailed error information for debugging

## Technical Details

- **Runtime**: Node.js with Puppeteer
- **Memory**: 4GB recommended for large classrooms
- **Timeout**: 1 hour default (adjust based on classroom size)
- **Dependencies**: Apify SDK, Puppeteer, XLSX

## Privacy & Security

- Credentials are handled securely using Apify's secret input fields
- No credentials or sensitive data are logged or stored
- All scraping respects Skool.com's structure and rate limits

## Support

For issues or questions:
1. Check the actor logs for detailed error information
2. Verify input parameters are correct
3. Ensure your Skool.com account has proper access
4. Contact support with specific error messages

## Changelog

### v1.0.0
- Initial release
- Enhanced and regular scraping methods
- Smart section expansion
- Comprehensive content extraction
- Error recovery and fallback mechanisms