'use strict';

/**
 * The storybook's list of buttons.
 *
 * The stories live in `src/dev-scenarios.js` (main's side of the fence), and
 * main hands them over by calling `renderStories()` once this page has loaded —
 * which is why the bridge in `preload-dev.js` only needs the one method that
 * plays one. Clicking a button fires that story's events at the dev buddy.
 */

const stories = document.getElementById('stories');

window.renderStories = (list) => {
  stories.replaceChildren();
  let group = null;
  for (const story of list || []) {
    if (story.group && story.group !== group) {
      group = story.group;
      const h = document.createElement('h2');
      h.textContent = group;
      stories.append(h);
    }
    const button = document.createElement('button');
    button.textContent = story.label;
    if (story.hint) {
      const hint = document.createElement('span');
      hint.className = 'hint';
      hint.textContent = story.hint;
      button.append(hint);
    }
    button.addEventListener('click', () => window.devAPI.fire(story.id));
    stories.append(button);
  }
};
