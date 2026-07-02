import axios from 'axios';
import * as cheerio from 'cheerio';
import NodeCache from 'node-cache';
import logger from './logger.js';

// Cache for 1 hour
const companyCache = new NodeCache({ stdTTL: 3600, checkperiod: 600 });

export function isPersonalEmail(email) {
  const personalDomains = [
    "gmail.com",
    "yahoo.com",
    "hotmail.com",
    "outlook.com",
    "icloud.com",
  ];
  const domain = email.split("@")[1]?.toLowerCase();
  return personalDomains.includes(domain);
}

export async function getCompanyInfo(domain) {
  if (companyCache.has(domain)) {
    logger.info(`Returning cached company info for domain: ${domain}`);
    return companyCache.get(domain);
  }

  const urls = [
    `https://www.${domain}`,
    `https://${domain}`,
    `http://www.${domain}`,
    `http://${domain}`,
  ];
  for (const url of urls) {
    try {
      logger.info(`Scraping company website: ${url}`);
      const response = await axios.get(url, {
        timeout: 5000,
        headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36" },
      });
      const html = response.data;
      const $ = cheerio.load(html);
      
      const title = $('title').text().trim() || `Company at ${domain}`;
      const description = $('meta[name="description"]').attr('content')?.trim() || '';
      
      // Get first h1 text or first p text
      let snippet = $('h1').first().text().trim();
      if (!snippet) {
        snippet = $('p').first().text().trim();
      }
      // Truncate snippet if too long
      if (snippet && snippet.length > 200) {
        snippet = snippet.substring(0, 200) + '...';
      }

      const result = {
        url,
        title,
        description,
        snippet: snippet || '',
      };
      
      companyCache.set(domain, result);
      return result;
    } catch (error) {
      logger.debug(`Could not fetch company info from ${url}: ${error.message}`);
    }
  }
  return null;
}

export async function getGithubInfo(name) {
  try {
    const response = await axios.get(
      `https://api.github.com/search/users?q=${encodeURIComponent(name)}`,
      { timeout: 5000 }
    );
    if (response.data.items && response.data.items.length > 0) {
      const user = response.data.items[0];
      return {
        url: user.html_url,
        title: `GitHub: ${user.login}`,
        content: `${user.public_repos} public repos, ${user.followers} followers`,
        type: "github",
      };
    }
  } catch (error) {
    logger.debug(`GitHub search error: ${error.message}`);
  }
  return null;
}

export async function doBasicResearch(memberInfo) {
  const results = [];
  try {
    if (memberInfo.email && !isPersonalEmail(memberInfo.email)) {
      const domain = memberInfo.email.split("@")[1];
      const companyInfo = await getCompanyInfo(domain);
      if (companyInfo) results.push(companyInfo);

      if (memberInfo.name) {
        const githubInfo = await getGithubInfo(memberInfo.name);
        if (githubInfo) results.push(githubInfo);
      }
    }
  } catch (error) {
    logger.error(`Research error for ${memberInfo.name}: ${error.message}`);
  }
  return results;
}
