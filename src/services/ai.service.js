import { ChatPromptTemplate } from "@langchain/core/prompts";
import logger from './logger.js';

export async function analyzeWithAI(model, memberInfo, researchData) {
  const companyName = process.env.COMPANY_NAME || "Our Company";
  const companyProduct = process.env.COMPANY_PRODUCT || "Our Product";

  const promptTemplate = ChatPromptTemplate.fromTemplate(`
    Analyze this new community member for fit with our commercial product.

    Company: ${companyName}
    Product: ${companyProduct}

    Member Info:
    - Name: {name}
    - Email: {email}
    - Title: {title}

    Research Data:
    {research}

    Provide a JSON response with the following fields:
    - fitScore (0-100): likelihood they'd be interested in our product
    - insights: array of 3-5 key observations about the member and their potential interest in our product
    - recommendations: array of 2-3 actionable recommendations for engaging this member

    Consider job title, company description and snippet, company size, technical background, and budget authority.
  `);

  try {
    const researchSummary = researchData.length > 0
      ? researchData.map((r) => {
          if (r.description !== undefined || r.snippet !== undefined) {
            return `- Company Website Info:\n  Title: ${r.title}\n  URL: ${r.url}\n  Description: ${r.description || 'N/A'}\n  Snippet: ${r.snippet || 'N/A'}`;
          } else {
            return `- ${r.title}: ${r.content} (${r.url})`;
          }
        }).join("\n")
      : "No additional research data available.";

    const chain = promptTemplate.pipe(model);
    const result = await chain.invoke({
      name: memberInfo.name,
      email: memberInfo.email,
      title: memberInfo.title,
      research: researchSummary,
    });

    const responseText = result.content || result;
    logger.info(`AI raw response text: ${responseText}`);

    let cleanedResponse = "";
    // BUG 2: Fragile JSON Parsing from OpenAI
    const match = responseText.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
    if (match) {
      cleanedResponse = match[1].trim();
    } else {
      cleanedResponse = responseText.trim();
    }

    // Sanitize trailing commas in JSON objects/arrays: e.g. [1, 2,] -> [1, 2]
    cleanedResponse = cleanedResponse.replace(/,(\s*[}\]])/g, '$1');

    let analysis;
    try {
      analysis = JSON.parse(cleanedResponse);
    } catch (parseError) {
      logger.error(`JSON.parse failed. Raw response: ${responseText}`);
      return {
        fitScore: 50,
        insights: ["Unable to complete full analysis"],
        recommendations: ["Manual review recommended"],
      };
    }

    return {
      fitScore: Math.max(0, Math.min(100, analysis.fitScore || 50)),
      insights: Array.isArray(analysis.insights)
        ? analysis.insights
        : ["Analysis completed, but no insights provided."],
      recommendations: Array.isArray(analysis.recommendations)
        ? analysis.recommendations
        : ["Follow up recommended."],
    };
  } catch (error) {
    logger.error(`AI analysis error: ${error.message}`);
    return {
      fitScore: 50,
      insights: ["Unable to complete full analysis"],
      recommendations: ["Manual review recommended"],
    };
  }
}
