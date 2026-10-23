/**
 * 站点定制抽取规则（命中优先于通用算法）
 * 借鉴参考包 Conflux crawler/siteRules.js
 */
export type SiteRule = {
  host: RegExp;
  selector: string;
  drop?: string;
  title?: string;
  author?: string;
  date?: string;
};

export const SITE_RULES: SiteRule[] = [
  {
    host: /mp\.weixin\.qq\.com/,
    selector: "#js_content, #page-content .rich_media_content",
    drop: ".qr_code_pc, .rich_media_tool, #js_pc_qr_code",
    title: "#activity-name, .rich_media_title",
    author: "#js_name, .rich_media_meta_nickname",
    date: "#publish_time",
  },
  { host: /zhihu\.com/, selector: ".Post-RichText, .RichContent-inner, .AnswerCard .RichText", drop: ".RichContent-actions" },
  { host: /36kr\.com/, selector: ".common-width.content, .articleDetailContent", drop: ".kr-article-bottom" },
  { host: /cnbeta|cnbeta\.com\.tw/, selector: "#artibody, .article-content, .articleCont" },
  { host: /ithome\.com/, selector: "#paragraph, .post_content", drop: ".related_post, #editor_baidu" },
  { host: /(sina\.com\.cn|sina\.cn)/, selector: "#artibody, .article-content-left .article, #article", drop: ".article-notice, .otherContent_01" },
  { host: /(qq\.com)/, selector: "#ArticleContent, .content-article, #Cnt-Main-Article-QQ, .qq_article" },
  { host: /163\.com/, selector: ".post_body, #endText, .post_text", drop: ".post_recommend, .gg200x300" },
  { host: /sohu\.com/, selector: "#mp-editor, article.article, #articleContent" },
  { host: /chinanews\.com(\.cn)?/, selector: ".left_zw, .content_desc, #cont_1_1_2, #content_views, .content_maincontent_content", drop: ".adEditor, .left_name" },
  { host: /people\.com\.cn|people\.cn/, selector: ".rm_txt_con, .box_con, #rwb_zw, .text_c" },
  { host: /xinhuanet\.com|news\.cn/, selector: "#detail, #p-detail, .main-aticle, #content, .main-left, .article" },
  { host: /thepaper\.cn/, selector: ".index_cententWrap__Jv8jK, .news_txt, .index_cententWrap" },
  { host: /jiemian\.com/, selector: ".article-content" },
  { host: /caixin\.com/, selector: "#the_content, .text" },
  { host: /huxiu\.com/, selector: ".article__content, #article-content" },
  { host: /infoq\.(cn|com)/, selector: ".article-preview, .article-content" },
  { host: /juejin\.cn/, selector: ".markdown-body, #article-root" },
  { host: /segmentfault\.com/, selector: ".article-content, .article__content" },
  { host: /oschina\.net/, selector: ".article-detail, .content" },
  { host: /csdn\.net/, selector: "#content_views, .blog-content-box", drop: ".hide-article-box, .recommend-box" },
  { host: /cnblogs\.com/, selector: "#cnblogs_post_body, #post_detail" },
  { host: /jianshu\.com/, selector: "article .show-content, ._2rhmJa" },
  { host: /weibo\.(com|cn)/, selector: ".WB_text, .weibo-text" },
  { host: /bilibili\.com/, selector: ".article-holder, #read-article-holder, .video-desc-container" },
  { host: /medium\.com/, selector: "article section, .postArticle-content" },
  { host: /substack\.com/, selector: ".available-content, .body.markup" },
  { host: /github\.com/, selector: "article.markdown-body, #readme .markdown-body" },
  { host: /stackoverflow\.com/, selector: "#question .js-post-body, .answer .js-post-body" },
  { host: /news\.ycombinator\.com/, selector: ".toptext, .comment-tree" },
  { host: /(nytimes|washingtonpost|theguardian|bbc|cnn|reuters|apnews|bloomberg|ft)\.com/, selector: "article, [data-component='text-block'], .article-body-commercial-selector, .ssrcss-uf6wea-RichTextComponent, section[name='articleBody'], #article-body" },
  { host: /aljazeera\.com/, selector: ".wysiwyg--all-content, #main-content-area" },
  { host: /dev\.to|forem\.com/, selector: "#article-body, .crayons-article__main" },
  { host: /arxiv\.org/, selector: ".ltx_abstract, #abs blockquote.abstract" },
  { host: /nature\.com|science\.org/, selector: ".c-article-body, #abstracts, article" },
  { host: /ted\.com/, selector: "[class*='Transcript'], .talk-transcript__para" },
  { host: /engadget\.com|theverge\.com|techcrunch\.com|arstechnica\.com|wired\.com/, selector: "article .article-text, .duet--article--article-body-component-container, .duet--article--article-body, .article-content, .post-content, article" },
  { host: /solidot\.org/, selector: ".p_mainnew, .article, #center" },
  { host: /sspai\.com/, selector: ".article-body, .content, article" },
  { host: /ifanr\.com/, selector: ".article-content, .c-article-content, .entry-content, article" },
  { host: /dw\.com/, selector: ".richtext, .longText, article, #bodyContent" },
  { host: /openai\.com/, selector: "article, .ui-article, main" },
  { host: /appinn\.com/, selector: ".article-content, .entry-content, .post-content, article" },
];

export function ruleFor(url: string): SiteRule | null {
  try {
    const host = new URL(url).hostname;
    return SITE_RULES.find((r) => r.host.test(host)) || null;
  } catch {
    return null;
  }
}

/** 常见翻页链接文案 */
export const PAGING_TEXT = /^(下一页|下页|下一頁|next\s*(page)?|»|›|后一页|第?\s*[2-9]\d*\s*页)$/i;
